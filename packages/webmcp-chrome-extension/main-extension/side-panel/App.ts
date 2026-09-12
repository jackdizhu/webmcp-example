// 侧边栏根组件（Vue 3 + TypeScript）——纯编排层。
//
// 职责边界：全局状态（设置/消息/页面路由/连接/调用日志）、agent 轮次编排（runTurn +
// 终止）、执行锁（agent 对话或 relay 调用进行中禁止切换页面）、traceId 与日志埋点、
// 生命周期（Port 桥接连断）。渲染全部下沉到 components/ 与 pages/（h() 渲染函数，
// MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { computed, defineComponent, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { API_PATH_EMPTY_HINT, createChatController, type AgentLoopEvent } from 'webmcp-agent-chat-core';
import { composeHandoffMessage, type DebugRun } from './debugger-core';
import {
  initLogger,
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
  toPanelSettings,
  type PageToolsClient,
  type PanelSettings,
} from './panel-client';
import { connectRelayStatus, type RelayStatusClient } from './relay-status-client';
import { createRelayStatusStore } from './relay-status-store';
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
    // relay 连接客户端（SW 状态端口；三路推送的订阅/消费收口在 relayStore，B2 归拢）
    let relayStatusClient: RelayStatusClient | null = null;

    // ---- relay 状态 store（B2 归拢：订阅/diff 日志/调用计数/终止语义收口）----
    const relayStore = createRelayStatusStore();

    /** 执行锁：agent 对话或 relay 调用进行中为 true。 */
    const locked = computed(() => busy.value || relayStore.runningCount.value > 0);
    /** 锁定期间 TabBar 展示的执行提示。 */
    const phaseLabel = computed(() => {
      if (busy.value) return 'agent 对话执行中';
      if (relayStore.runningCount.value > 0) return 'relay 调用执行中';
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

    // ---- agent 对话编排（共享库 webmcp-agent-chat-core，B1 归位）----
    // 控制器持有 history/busy/终止语义；宿主经依赖注入提供工具源、配置 getter、
    // UI 适配器与横切设施（执行锁 / traceId / 日志）。P1 的智能体状态将在此增量。
    const chatController = createChatController({
      getTools: async () => {
        // 每轮发送前刷新工具清单，保证页面工具变化（listChanged）能被感知；
        // 清单含内置工具（chrome_extension_*，由 attachBuiltinTools 合成）
        const tools = await pageTools!.listTools();
        toolsCount.value = tools.length;
        return tools;
      },
      callTool: (name, args) => pageTools!.callTool(name, args),
      getLlmConfig: () => ({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        apiPath: settings.apiPath,
        model: settings.model,
        apiProtocol: settings.apiProtocol,
        maxTokens: settings.maxTokens,
      }),
      getSystemPrompt: () => settings.systemPrompt,
      getMaxHistoryTurns: () => settings.maxHistoryTurns,
      onUserMessage: (text) => pushUiMessage('user', text),
      createTurnView: () => {
        const item = pushUiMessage('assistant', '');
        return {
          onEvent: (event) => applyEvent(item, event),
          setText: (text) => {
            item.content = text;
          },
        };
      },
      onMissingApiKey: () => {
        setTab('settings');
        pushUiMessage('assistant', '请先在「设置」页填写 API Key 后再开始对话。');
      },
      onMissingApiPath: () => {
        setTab('settings');
        pushUiMessage('assistant', API_PATH_EMPTY_HINT);
      },
      onBusyChange: (value) => {
        busy.value = value;
      },
      onTurnStart: () => {
        // 本轮对话追踪 ID：贯穿 tools/LLM/桥接全部埋点（runTurn 串行保证 current 唯一）
        setCurrentTrace(generateTraceId());
      },
      onTurnSettled: () => {
        clearCurrentTrace();
      },
      onLog: (level, event, payload) => logEvent(level, 'chat', event, payload),
    });

    // relay 状态快照/选择/调用日志已收口 relayStore（B2 归位）：本层仅绑定客户端、
    // 在选择变化时同步 pageTools 目标并刷新工具清单。

    const send = async (): Promise<void> => {
      const userText = input.value.trim();
      if (locked.value || userText.length === 0 || !pageTools) return;
      input.value = '';
      await chatController.runTurn(userText);
    };

    /** 调试页「发送到对话」：把执行记录组装成预设消息交给 agent 继续分析。 */
    const handleHandoff = async (run: DebugRun): Promise<void> => {
      if (locked.value) return;
      setTab('chat');
      await chatController.runTurn(composeHandoffMessage(run));
    };

    /** 全局「终止」：终止 agent 对话（共享库控制器 AbortSignal）+ 停止等待 relay 调用。 */
    const terminate = (): void => {
      if (busy.value) chatController.abort();
      if (relayStore.runningCount.value > 0) {
        relayStore.terminateWait();
        logEvent('info', 'relay', 'invoke_wait_terminated', `${String(relayStore.runningCount.value)} 个调用停止等待`);
      }
    };

    /** 把响应式 settings 收敛为待持久化快照（序列化收口在 panel-client，A5 归位）。 */
    const persistSettings = async (): Promise<void> => {
      await saveSettings(toPanelSettings(settings));
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

    // 设置页日志区块管理已下沉 SettingsPage（A3/A4 归位）：本层不再持有 logCount/hint
    // 状态与 export/clear handler，也不再用 watch(activeTab) 代刷——页面 watch(active) 自管。

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
      // 内置工具的「当前选中页签」直接取 relayStore 的全局选择快照
      pageTools = attachBuiltinTools(connectPageTools(), {
        getSelectedTabIds: () => relayStore.selection.value.tabIds,
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

      // relay 连接客户端创建 + store 三路订阅绑定：状态栏 / 数据源设置页 / 调用日志页
      relayStatusClient = connectRelayStatus();
      relayStore.bind(relayStatusClient, {
        onSelectionChanged: (selection) => {
          // 全局选择驱动侧栏 agent / tools 调试的连接目标（多选全端生效，Q2）；
          // 选中集合为空 = 无目标，客户端整体离线
          pageTools?.setTargetTabs(selection.tabIds);
          void refreshTools();
        },
      });

      // Q5 决策：侧栏打开即重置选择为当前活动页签（覆盖上次手动多选）；
      // SW 推送新 selection 后上面的订阅回调完成建连
      relayStore.requestResetSelection();

      await refreshTools();
    });

    onUnmounted(() => {
      unsubscribeStatus?.();
      unsubscribeToolsChange?.();
      relayStore.dispose();
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
        h(RelayStatusBar, { statuses: relayStore.statuses.value }),
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
          invokeLogs: relayStore.invokeLogs.value,
          runningCount: relayStore.runningCount.value,
          terminated: relayStore.terminated.value,
        }),
        h(DataSourcePage, {
          active: activeTab.value === 'datasource',
          statuses: relayStore.statuses.value,
          selection: relayStore.selection.value,
          locked: locked.value,
          relayStatus: relayStatusClient,
        }),
        h(SettingsPage, {
          active: activeTab.value === 'settings',
          settings,
          busy: locked.value,
          onSave: () => void persistSettings(),
        }),
      ]);
  },
});
