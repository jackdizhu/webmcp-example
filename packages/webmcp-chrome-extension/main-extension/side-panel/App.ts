// 侧边栏聊天框根组件（Vue 3 + TypeScript）——纯编排层。
//
// 职责边界：状态（设置/消息/Tab/连接）、agent 轮次编排（runTurn）、traceId 与日志埋点、
// 生命周期（Port 桥接连断）。渲染全部下沉到 components/ 下的独立组件（h() 渲染函数，
// MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { runAgentLoop, type AgentLoopEvent, type AgentTool, type ChatMessage } from './agent-loop';
import { composeHandoffMessage, type DebugRun } from './debugger-core';
import { createOpenAiCompatClient } from './llm-client';
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
  connectPageTools,
  loadSettings,
  saveSettings,
  type PageToolsClient,
  type PanelSettings,
} from './panel-client';
import { connectRelayStatus } from './relay-status-client';
import type { RelayTabStatus } from '../../core/relay-status-protocol';
import { AppHeader } from './components/AppHeader';
import { RelayStatusBar } from './components/RelayStatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { TabBar } from './components/TabBar';
import { TOOL_PENDING_TEXT, type UiMessage } from './components/types';
import { ChatPage } from './pages/ChatPage';
import { DebugPage } from './pages/DebugPage';

export const App = defineComponent({
  name: 'SidePanelApp',
  setup() {
    const messages = ref<UiMessage[]>([]);
    const input = ref('');
    const busy = ref(false);
    const connected = ref(false);
    const toolsCount = ref(0);
    const showSettings = ref(false);
    const settings = reactive<PanelSettings>({
      apiKey: '',
      baseUrl: '',
      model: '',
      debugMode: false,
      consoleOutput: false,
    });
    /** 顶部 Tab：对话 / 调试（调试 Tab 仅在 debugMode 开启时可见）。 */
    const activeTab = ref<'chat' | 'debug'>('chat');
    /** 供渲染调试组件使用的客户端引用（onMounted 后非空）。 */
    const pageToolsRef = ref<PageToolsClient | null>(null);

    let pageTools: PageToolsClient | null = null;
    let unsubscribeStatus: (() => void) | null = null;
    let unsubscribeToolsChange: (() => void) | null = null;
    // relay 连接状态订阅（SW 状态端口推送各标签页连接快照）
    let relayStatusClient: ReturnType<typeof connectRelayStatus> | null = null;
    let unsubscribeRelayStatus: (() => void) | null = null;
    /** 各标签页上一次的连接状态（diff 出迁移事件写日志）。 */
    const relayStateCache = new Map<number, string>();
    // agent 循环的多轮对话历史（不含 system 消息），跨轮次保留上下文
    let history: ChatMessage[] = [];

    const pushUiMessage = (role: UiMessage['role'], content: string): UiMessage => {
      const item: UiMessage = { role, content, toolTrace: [] };
      messages.value.push(item);
      return item;
    };

    const refreshTools = async (): Promise<void> => {
      if (!pageTools) return;
      try {
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
      if (busy.value || !pageTools) return;

      if (settings.apiKey.length === 0) {
        showSettings.value = true;
        pushUiMessage('assistant', '请先在「设置」中填写 API Key 后再开始对话。');
        return;
      }

      busy.value = true;
      pushUiMessage('user', userText);
      // 本轮对话追踪 ID：贯穿 tools/LLM/桥接全部埋点（runTurn 串行保证 current 唯一）
      const traceId = generateTraceId();
      setCurrentTrace(traceId);
      logEvent('info', 'chat', 'turn_start', userText);
      const assistantItem = pushUiMessage('assistant', '');

      try {
        // 每轮发送前刷新工具清单，保证页面工具变化（listChanged）能被感知
        const tools: AgentTool[] = await pageTools.listTools();
        toolsCount.value = tools.length;

        const llm = createOpenAiCompatClient({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
        });
        const result = await runAgentLoop(
          // 历史以本轮用户消息结尾（agent-loop 约定）
          [...history, { role: 'user' as const, content: userText }],
          tools,
          {
            llm,
            executeTool: (name, args) => pageTools!.callTool(name, args),
          },
          {
            onEvent: (event) => applyEvent(assistantItem, event),
          }
        );
        assistantItem.content = result.text;
        history = result.transcript;
        logEvent('info', 'chat', 'turn_end', result.text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assistantItem.content = `出错了：${message}`;
        logEvent('error', 'chat', 'turn_error', message);
      } finally {
        clearCurrentTrace();
        busy.value = false;
      }
    };

    const relayStatuses = ref<RelayTabStatus[]>([]);

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
      if (busy.value || userText.length === 0 || !pageTools) return;
      input.value = '';
      await runTurn(userText);
    };

    /** 调试 Tab「发送到对话」：把执行记录组装成预设消息交给 agent 继续分析。 */
    const handleHandoff = async (run: DebugRun): Promise<void> => {
      if (busy.value) return;
      activeTab.value = 'chat';
      await runTurn(composeHandoffMessage(run));
    };

    /** 设置面板「快速切换调试模式」：立即持久化并生效，不等「保存」按钮。 */
    const toggleDebugMode = async (): Promise<void> => {
      settings.debugMode = !settings.debugMode;
      await saveSettings({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        debugMode: settings.debugMode,
        consoleOutput: settings.consoleOutput,
      });
      logEvent('info', 'app', 'debug_mode_toggled', settings.debugMode ? 'on' : 'off');
      if (settings.debugMode) {
        // 开启：关闭设置面板并直达调试 Tab（一键入口的核心诉求）
        showSettings.value = false;
        activeTab.value = 'debug';
      } else if (activeTab.value === 'debug') {
        // 关闭：若停留在调试 Tab 则切回对话，设置面板保持打开
        activeTab.value = 'chat';
      }
    };

    const persistSettings = async (): Promise<void> => {
      await saveSettings({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        debugMode: settings.debugMode,
        consoleOutput: settings.consoleOutput,
      });
      // 控制台输出开关立即生效（保存后无需重开侧栏）
      setConsoleOutput(settings.consoleOutput);
      // 关闭调试模式时若停留在调试 Tab，切回对话
      if (!settings.debugMode && activeTab.value === 'debug') activeTab.value = 'chat';
      showSettings.value = false;
      pushUiMessage(
        'assistant',
        settings.consoleOutput
          ? '设置已保存。控制台输出已开启：在侧边栏上右键 →「检查」打开控制台，用过滤框输入 traceId 可筛出该轮完整链路。'
          : '设置已保存。'
      );
      await refreshTools();
    };

    /** 本地日志区块状态（设置面板内）。 */
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

    // 打开设置面板时刷新日志条数展示
    watch(showSettings, (visible) => {
      if (visible) {
        logHint.value = '';
        void refreshLogCount();
      }
    });

    onMounted(async () => {
      await initLogger();
      logEvent('info', 'app', 'sidepanel_opened');

      const loaded = await loadSettings();
      settings.apiKey = loaded.apiKey;
      settings.baseUrl = loaded.baseUrl;
      settings.model = loaded.model;
      settings.debugMode = loaded.debugMode;
      settings.consoleOutput = loaded.consoleOutput;
      setConsoleOutput(loaded.consoleOutput);

      pageTools = connectPageTools();
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

      // relay 连接状态订阅：连接/变更快照 → 状态栏 + 日志管线
      relayStatusClient = connectRelayStatus();
      unsubscribeRelayStatus = relayStatusClient.onUpdate(applyRelayStatuses);

      await refreshTools();
    });

    onUnmounted(() => {
      unsubscribeStatus?.();
      unsubscribeToolsChange?.();
      unsubscribeRelayStatus?.();
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
            showSettings.value = !showSettings.value;
          },
        }),
        h(RelayStatusBar, { statuses: relayStatuses.value }),
        settings.debugMode
          ? h(TabBar, {
              activeTab: activeTab.value,
              'onUpdate:activeTab': (value: 'chat' | 'debug') => {
                activeTab.value = value;
              },
            })
          : null,
        showSettings.value
          ? h(SettingsPanel, {
              settings,
              busy: busy.value,
              logCountText: logCountText.value,
              logHint: logHint.value,
              onSave: () => void persistSettings(),
              onToggleDebug: () => void toggleDebugMode(),
              onExportLogs: () => void handleExportLogs(),
              onClearLogs: () => void handleClearLogs(),
            })
          : null,
        h(ChatPage, {
          messages: messages.value,
          busy: busy.value,
          active: activeTab.value === 'chat',
          modelValue: input.value,
          'onUpdate:modelValue': (value: string) => {
            input.value = value;
          },
          onSend: () => void send(),
        }),
        settings.debugMode && pageToolsRef.value
          ? h(DebugPage, {
              pageTools: pageToolsRef.value,
              active: activeTab.value === 'debug',
              onHandoff: (run: DebugRun) => {
                void handleHandoff(run);
              },
            })
          : null,
      ]);
  },
});
