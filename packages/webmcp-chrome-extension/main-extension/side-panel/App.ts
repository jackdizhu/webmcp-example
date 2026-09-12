// 侧边栏根组件（Vue 3 + TypeScript）——纯编排层。
//
// 职责边界：全局状态（设置/消息/页面路由/连接/调用日志）、agent 轮次编排（runTurn +
// 终止）、执行锁（agent 对话或 relay 调用进行中禁止切换页面）、traceId 与日志埋点、
// 生命周期（Port 桥接连断）。渲染全部下沉到 components/ 与 pages/（h() 渲染函数，
// MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { computed, defineComponent, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { AgentAbortError, runAgentLoop, trimHistory, type AgentLoopEvent, type AgentLoopOptions, type AgentTool, type ChatMessage } from './agent-loop';
import { composeHandoffMessage, type DebugRun } from './debugger-core';
import { createLlmClient, API_PATH_EMPTY_HINT } from './llm-client';
import {
  clearLogs,
  exportLogs,
  initLogger,
  logCount,
  logEvent,
  setConsoleOutput,
} from './logger';
import {
  clearCurrentTrace,
  generateTraceId,
  setCurrentTrace,
} from './trace-context';
import {
  attachBuiltinTools,
  connectPageTools,
  loadSettings,
  saveSettings,
  type PageToolsClient,
  type PanelSettings,
} from './panel-client';
import { connectRelayStatus } from './relay-status-client';
import type { RelayInvokeLogEntry, RelayTabSelection, RelayTabStatus } from '../../core/relay-status-protocol';
import { AppHeader } from './components/AppHeader';
import { RelayStatusBar } from './components/RelayStatusBar';
import { TabBar, type PanelPage } from './components/TabBar';
import { TOOL_PENDING_TEXT, type UiMessage } from './components/types';
import { ChatPage } from './pages/ChatPage';
import { DataSourcePage } from './pages/DataSourcePage';
import { DebugPage } from './pages/DebugPage';
import { RelayPage } from './pages/RelayPage';
import { SettingsPage } from './pages/SettingsPage';

export const App = defineComponent({
  name: 'SidePanelApp',
  setup() {
    const messages = ref<UiMessage[]>([]);
    const input = ref('');
    const busy = ref(false);
    const connected = ref(false);
    const toolsCount = ref(0);
    const settings = reactive<PanelSettings>({
      apiKey: '',
      baseUrl: '',
      apiPath: '',
      model: '',
      apiProtocol: 'openai-compat',
      maxTokens: 4096,
      debugMode: false,
      consoleOutput: false,
      systemPrompt: '',
      maxHistoryTurns: 0,
    });
    /** 顶部页面路由：agent 对话 / tools 调试 / relay 调用 / 数据源设置 / 设置。 */
    const activeTab = ref<PanelPage>('chat');
    /** 供渲染调试组件使用的客户端引用（onMounted 后非空）。 */
    const pageToolsRef = ref<PageToolsClient | null>(null);

    let pageTools: PageToolsClient | null = null;
    let unsubscribeStatus: (() => void) | null = null;
    let unsubscribeToolsChange: (() => void) | null = null;
    // relay 连接状态订阅（SW 状态端口推送各标签页连接快照 + 调用日志）
    let relayStatusClient: ReturnType<typeof connectRelayStatus> | null = null;
    let unsubscribeRelayStatus: (() => void) | null = null;
    let unsubscribeInvokeLogs: (() => void) | null = null;
    let unsubscribeRelaySelection: (() => void) | null = null;
    /** 各标签页上一次的连接状态（diff 出迁移事件写日志）。 */
    const relayStateCache = new Map<number, string>();
    // agent 循环的多轮对话历史（不含 system 消息），跨轮次保留上下文
    let history: ChatMessage[] = [];
    /** 本轮对话的终止控制器（runTurn 期间非空）。 */
    let chatAbort: AbortController | null = null;

    // ---- relay 调用日志（「relay 调用」页只读展示 + 执行锁数据源）----
    const invokeLogs = ref<RelayInvokeLogEntry[]>([]);
    /** 执行中的 relay 调用数（ok 缺省 = 仍在执行）。 */
    const relayRunningCount = computed(
      () => invokeLogs.value.filter((entry) => entry.ok === undefined).length
    );
    /**
     * 用户已对 relay 调用点「终止」：执行锁立即解除，UI 停止等待；
     * 页面工具调用无法真正中断，后台完成后结果照常落入日志。
     */
    const relayTerminated = ref(false);
    watch(relayRunningCount, (count) => {
      if (count === 0) relayTerminated.value = false;
    });

    /** 执行锁：agent 对话或 relay 调用进行中为 true。 */
    const locked = computed(() => busy.value || relayRunningCount.value > 0);
    /** 锁定期间 TabBar 展示的执行提示。 */
    const phaseLabel = computed(() => {
      if (busy.value) return 'agent 对话执行中';
      if (relayRunningCount.value > 0) return 'relay 调用执行中';
      return '';
    });

    /** 页面路由守卫：执行锁生效期间禁止切换（TabBar 已禁用，此处兜底）。 */
    const setTab = (next: PanelPage): void => {
      if (locked.value) return;
      activeTab.value = next;
    };

    const pushUiMessage = (role: UiMessage['role'], content: string): UiMessage => {
      const item: UiMessage = { role, content, toolTrace: [] };
      messages.value.push(item);
      return item;
    };

    const refreshTools = async (): Promise<void> => {
      if (!pageTools) return;
      try {
        // 工具数含内置工具（chrome_extension_*，attachBuiltinTools 已合并）
        toolsCount.value = (await pageTools.listTools()).length;
      } catch {
        toolsCount.value = 0;
      }
    };

    /** 把过程事件回填到助手消息的工具痕迹里。 */
    const applyEvent = (target: UiMessage, event: AgentLoopEvent): void => {
      if (event.type === 'tool_start') {
        target.toolTrace.push({ name: event.name, result: TOOL_PENDING_TEXT, failed: false });
        logEvent('info', 'tools', 'tool_start', { name: event.name });
        return;
      }
      if (event.type === 'tool_result' || event.type === 'tool_error') {
        const pending = [...target.toolTrace].reverse().find(
          (item) => item.name === event.name && item.result === TOOL_PENDING_TEXT
        );
        if (event.type === 'tool_result') {
          if (pending) pending.result = event.result;
          else target.toolTrace.push({ name: event.name, result: event.result, failed: false });
          logEvent('info', 'tools', 'tool_result', { name: event.name, result: event.result });
        } else {
          if (pending) {
            pending.result = event.error;
            pending.failed = true;
          } else {
            target.toolTrace.push({ name: event.name, result: event.error, failed: true });
          }
          logEvent('error', 'tools', 'tool_error', { name: event.name, error: event.error });
        }
      }
    };

    /** 运行一轮 agent 对话（send 与调试「发送到对话」共用）。 */
    const runTurn = async (userText: string): Promise<void> => {
      if (locked.value || !pageTools) return;

      if (settings.apiKey.length === 0) {
        setTab('settings');
        pushUiMessage('assistant', '请先在「设置」页填写 API Key 后再开始对话。');
        return;
      }

      // apiPath 显式清空（空串）不回退默认路径：引导回设置页配置
      if (settings.apiPath.trim().length === 0) {
        setTab('settings');
        pushUiMessage('assistant', API_PATH_EMPTY_HINT);
        return;
      }

      busy.value = true;
      chatAbort = new AbortController();
      pushUiMessage('user', userText);
      // 本轮对话追踪 ID：贯穿 tools/LLM/桥接全部埋点（runTurn 串行保证 current 唯一）
      const traceId = generateTraceId();
      setCurrentTrace(traceId);
      logEvent('info', 'chat', 'turn_start', userText);
      const assistantItem = pushUiMessage('assistant', '');
      const signal = chatAbort.signal;

      try {
        // 每轮发送前刷新工具清单，保证页面工具变化（listChanged）能被感知；
        // 清单含内置工具（chrome_extension_*，由 attachBuiltinTools 合成）
        const tools: AgentTool[] = await pageTools.listTools();
        toolsCount.value = tools.length;

        const llm = createLlmClient({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          apiPath: settings.apiPath,
          model: settings.model,
          apiProtocol: settings.apiProtocol,
          maxTokens: settings.maxTokens,
        });
        // 历史裁剪：保留最近 maxHistoryTurns 轮（0 = 不裁剪），随 transcript 收敛逐轮有界
        const boundedHistory = trimHistory(history, settings.maxHistoryTurns);
        const loopOptions: AgentLoopOptions = {
          onEvent: (event) => applyEvent(assistantItem, event),
          signal,
        };
        // 空串归一化为 undefined：agent-loop 的 ?? 回退仅对 undefined/null 生效
        // （exactOptionalPropertyTypes 下不能直接塞 undefined，故按需赋值）
        const trimmedPrompt = settings.systemPrompt.trim();
        if (trimmedPrompt) loopOptions.systemPrompt = trimmedPrompt;
        const result = await runAgentLoop(
          // 历史以本轮用户消息结尾（agent-loop 约定）
          [...boundedHistory, { role: 'user' as const, content: userText }],
          tools,
          {
            llm,
            // 内置工具与页面工具统一经合成客户端路由（内置名在扩展上下文执行）
            executeTool: (name, args) => pageTools!.callTool(name, args),
          },
          loopOptions
        );
        assistantItem.content = result.text;
        history = result.transcript;
        logEvent('info', 'chat', 'turn_end', result.text);
      } catch (error) {
        if (error instanceof AgentAbortError || signal.aborted) {
          assistantItem.content = '已终止本轮对话（未完成）。';
          logEvent('info', 'chat', 'turn_aborted');
        } else {
          const message = error instanceof Error ? error.message : String(error);
          assistantItem.content = `出错了：${message}`;
          logEvent('error', 'chat', 'turn_error', message);
        }
      } finally {
        clearCurrentTrace();
        busy.value = false;
        chatAbort = null;
      }
    };

    const relayStatuses = ref<RelayTabStatus[]>([]);
    /** 全局标签页数据源选择（SW 推送；默认 = 打开侧栏时的活动页签，多选全端生效）。 */
    const relaySelection = ref<RelayTabSelection>({ tabIds: [] });

    /** 数据源设置页 checkbox 勾选：合并出新选中集发给 SW（全端生效：relay + agent + 调试）。 */
    const toggleRelayTab = (tabId: number, checked: boolean): void => {
      if (!relayStatusClient) return;
      const next = new Set(relaySelection.value.tabIds);
      if (checked) next.add(tabId);
      else next.delete(tabId);
      relayStatusClient.sendRequest({ type: 'set-selection', tabIds: [...next] });
      logEvent('info', 'relay', 'relay_selection_toggle', `tab ${String(tabId)} → ${checked ? 'selected' : 'deselected'}`);
    };

    /** 数据源设置页「重置」：回到默认（当前活动页签，单选；覆盖手动多选，Q5 语义）。 */
    const resetRelaySelection = (): void => {
      relayStatusClient?.sendRequest({ type: 'reset-selection' });
      logEvent('info', 'relay', 'relay_selection_reset', 'active-tab');
    };

    /** relay 状态快照落 UI，并把逐 tab 的状态迁移写入日志管线（可导出排查）。 */
    const applyRelayStatuses = (statuses: RelayTabStatus[]): void => {
      relayStatuses.value = statuses;
      const seen = new Set<number>();
      for (const status of statuses) {
        seen.add(status.tabId);
        const prev = relayStateCache.get(status.tabId);
        if (prev !== status.state) {
          relayStateCache.set(status.tabId, status.state);
          logEvent('info', 'relay', 'relay_status', `tab ${String(status.tabId)} → ${status.state}${status.detail ? ` (${status.detail})` : ''}`);
        }
      }
      for (const tabId of [...relayStateCache.keys()]) {
        if (!seen.has(tabId)) {
          relayStateCache.delete(tabId);
          logEvent('info', 'relay', 'relay_status', `tab ${String(tabId)} → removed`);
        }
      }
    };

    const send = async (): Promise<void> => {
      const userText = input.value.trim();
      if (locked.value || userText.length === 0 || !pageTools) return;
      input.value = '';
      await runTurn(userText);
    };

    /** 调试页「发送到对话」：把执行记录组装成预设消息交给 agent 继续分析。 */
    const handleHandoff = async (run: DebugRun): Promise<void> => {
      if (locked.value) return;
      setTab('chat');
      await runTurn(composeHandoffMessage(run));
    };

    /** 全局「终止」：终止 agent 对话（AbortSignal）+ 停止等待 relay 调用。 */
    const terminate = (): void => {
      if (busy.value) {
        chatAbort?.abort();
        logEvent('info', 'chat', 'turn_abort_requested');
      }
      if (relayRunningCount.value > 0) {
        relayTerminated.value = true;
        logEvent('info', 'relay', 'invoke_wait_terminated', `${String(relayRunningCount.value)} 个调用停止等待`);
      }
    };

    /** 把响应式 settings 收敛为待持久化快照，避免 saveSettings 调用处手写字段列表（含新增字段）。 */
    const toPanelSettings = (): PanelSettings => ({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      apiPath: settings.apiPath,
      model: settings.model,
      apiProtocol: settings.apiProtocol,
      maxTokens: settings.maxTokens,
      debugMode: settings.debugMode,
      consoleOutput: settings.consoleOutput,
      systemPrompt: settings.systemPrompt,
      maxHistoryTurns: settings.maxHistoryTurns,
    });

    const persistSettings = async (): Promise<void> => {
      await saveSettings(toPanelSettings());
      // 控制台输出开关立即生效（保存后无需重开侧栏）
      setConsoleOutput(settings.consoleOutput);
      setTab('chat');
      pushUiMessage(
        'assistant',
        settings.consoleOutput
          ? '设置已保存。控制台输出已开启：在侧边栏上右键 →「检查」打开控制台，用过滤框输入 traceId 可筛出该轮完整链路。'
          : '设置已保存。'
      );
      await refreshTools();
    };

    /** 本地日志区块状态（设置页内）。 */
    const logCountText = ref('');
    const logHint = ref('');

    const refreshLogCount = async (): Promise<void> => {
      logCountText.value = `${await logCount()} 条`;
    };

    const handleExportLogs = async (): Promise<void> => {
      const filename = await exportLogs();
      if (filename) {
        logHint.value = `已导出 ${filename}`;
        logEvent('info', 'app', 'logs_exported', filename);
      } else {
        logHint.value = '暂无日志可导出';
      }
      await refreshLogCount();
    };

    const handleClearLogs = async (): Promise<void> => {
      await clearLogs();
      logHint.value = '日志已清空';
      logEvent('info', 'app', 'logs_cleared');
      await refreshLogCount();
    };

    // 进入设置页时刷新日志条数展示
    watch(activeTab, (tab) => {
      if (tab === 'settings') {
        logHint.value = '';
        void refreshLogCount();
      }
    });

    onMounted(async () => {
      await initLogger();
      logEvent('info', 'app', 'sidepanel_opened');

      const loaded = await loadSettings();
      settings.apiKey = loaded.apiKey;
      settings.apiPath = loaded.apiPath;
      settings.baseUrl = loaded.baseUrl;
      settings.model = loaded.model;
      settings.apiProtocol = loaded.apiProtocol;
      settings.maxTokens = loaded.maxTokens;
      settings.debugMode = loaded.debugMode;
      settings.consoleOutput = loaded.consoleOutput;
      settings.systemPrompt = loaded.systemPrompt;
      settings.maxHistoryTurns = loaded.maxHistoryTurns;
      setConsoleOutput(loaded.consoleOutput);
      // 调试模式：侧栏打开时默认进入 tools 调试页
      if (settings.debugMode) activeTab.value = 'debug';

      // 页面工具客户端 + 内置工具合成：agent 对话与 tools 调试页共用同一实例，
      // 内置工具的「当前选中页签」直接取全局选择快照（relaySelection）
      pageTools = attachBuiltinTools(connectPageTools(), {
        getSelectedTabIds: () => relaySelection.value.tabIds,
      });
      pageToolsRef.value = pageTools;
      unsubscribeStatus = pageTools.onStatusChange((value) => {
        const wasConnected = connected.value;
        connected.value = value;
        logEvent(value ? 'info' : 'warn', 'bridge', value ? 'bridge_connected' : 'bridge_disconnected');
        // 恢复在线即刷新清单：挂载时桥接往往未就绪，首次拉取会失败停在 0
        if (!wasConnected && value) void refreshTools();
      });
      // 页面动态注册/注销工具（桥接 toolsChanged 推送）时同步侧栏展示
      unsubscribeToolsChange = pageTools.onToolsChange(() => {
        void refreshTools();
      });

      // relay 连接状态 + 调用日志 + 全局标签页选择订阅：状态栏 / 数据源设置页 / 调用日志页
      relayStatusClient = connectRelayStatus();
      unsubscribeRelayStatus = relayStatusClient.onUpdate(applyRelayStatuses);
      unsubscribeInvokeLogs = relayStatusClient.onInvokeLogs((entries) => {
        invokeLogs.value = entries;
      });
      unsubscribeRelaySelection = relayStatusClient.onSelectionChange((selection) => {
        relaySelection.value = selection;
        // 全局选择驱动侧栏 agent / tools 调试的连接目标（多选全端生效，Q2）；
        // 选中集合为空 = 无目标，客户端整体离线
        pageTools?.setTargetTabs(selection.tabIds);
        void refreshTools();
      });

      // Q5 决策：侧栏打开即重置选择为当前活动页签（覆盖上次手动多选）；
      // SW 推送新 selection 后上面的订阅回调完成建连
      relayStatusClient.sendRequest({ type: 'reset-selection' });

      await refreshTools();
    });

    onUnmounted(() => {
      unsubscribeStatus?.();
      unsubscribeToolsChange?.();
      unsubscribeRelayStatus?.();
      unsubscribeInvokeLogs?.();
      unsubscribeRelaySelection?.();
      relayStatusClient?.disconnect();
      pageTools?.disconnect();
      pageTools = null;
    });

    // ---- 组件编排（页面级视图在 pages/，独立组件在 components/）----

    return () =>
      h('div', { class: 'panel' }, [
        h(AppHeader, {
          connected: connected.value,
          toolsCount: toolsCount.value,
          onToggleSettings: () => {
            setTab('settings');
          },
        }),
        h(RelayStatusBar, { statuses: relayStatuses.value }),
        h(TabBar, {
          activeTab: activeTab.value,
          locked: locked.value,
          phaseLabel: phaseLabel.value,
          'onUpdate:activeTab': (value: PanelPage) => {
            setTab(value);
          },
          onAbort: () => terminate(),
        }),
        h(ChatPage, {
          messages: messages.value,
          busy: busy.value,
          locked: locked.value,
          active: activeTab.value === 'chat',
          modelValue: input.value,
          'onUpdate:modelValue': (value: string) => {
            input.value = value;
          },
          onSend: () => void send(),
        }),
        pageToolsRef.value
          ? h(DebugPage, {
              pageTools: pageToolsRef.value,
              active: activeTab.value === 'debug',
              locked: locked.value,
              onHandoff: (run: DebugRun) => {
                void handleHandoff(run);
              },
            })
          : null,
        h(RelayPage, {
          active: activeTab.value === 'relay',
          invokeLogs: invokeLogs.value,
          runningCount: relayRunningCount.value,
          terminated: relayTerminated.value,
        }),
        h(DataSourcePage, {
          active: activeTab.value === 'datasource',
          statuses: relayStatuses.value,
          selection: relaySelection.value,
          locked: locked.value,
          relayStatus: relayStatusClient,
          onToggleTab: toggleRelayTab,
          onResetSelection: resetRelaySelection,
        }),
        h(SettingsPage, {
          active: activeTab.value === 'settings',
          settings,
          busy: locked.value,
          logCountText: logCountText.value,
          logHint: logHint.value,
          onSave: () => void persistSettings(),
          onExportLogs: () => void handleExportLogs(),
          onClearLogs: () => void handleClearLogs(),
        }),
      ]);
  },
});
