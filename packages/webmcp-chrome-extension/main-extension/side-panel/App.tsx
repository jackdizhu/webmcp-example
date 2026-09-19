// 侧边栏根组件（Vue 3 + TypeScript）——纯编排层。
//
// 职责边界：全局状态（设置/消息/页面路由/连接/调用日志）、agent 轮次编排（runTurn +
// 终止）、执行锁（agent 对话或 relay 调用进行中禁止切换页面）、traceId 与日志埋点、
// 生命周期（Port 桥接连断）。渲染全部下沉到 components/ 与 pages/（TSX 模板：
// 构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，与 MV3 扩展页
// CSP script-src 'self' 兼容，见 issues/001）。
import { computed, defineComponent, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  API_PATH_EMPTY_HINT,
  buildSkillL1Section,
  composeSystemPrompt,
  createChatController,
  createSkillResolver,
  createSkillToolDefinition,
  excludeAgentChannelTools,
  mergeLlmConfig,
  parseSkillToolArgs,
  SKILL_TOOL_NAME,
  toSkillToolError,
  toSkillToolResult,
  type AgentA2aRef,
  type AgentInitSnapshot,
  type AgentLoopEvent,
  type SkillSummary,
} from 'webmcp-agent-chat-core';
import { createA2aToolHost, loadA2aTokens, saveA2aTokens } from './a2a/a2a-host';
import { loadA2aConfig, saveA2aConfig, toA2aConfigSnapshot } from './a2a/a2a-config-store';
import { createAgentProfileStore } from './a2a/agent-profile-store';
import { initLocale, joinList, t } from './i18n';
import { createHostSkillSource, getBuiltinSkillSummary, BUILTIN_SKILLS } from './runtime/skill-assets';
import { createAgentInitPusher } from './runtime/agent-init-pusher';
import { createAgentTaskHost } from './runtime/agent-task-host';
import { composeHandoffMessage, type DebugRun } from './runtime/debugger-core';
import {
  initLogger,
  logEvent,
  setConsoleOutput,
} from './logger/logger';
import {
  clearCurrentTrace,
  generateTraceId,
  setCurrentTrace,
} from './logger/trace-context';
import {
  attachBuiltinTools,
  attachInjectedTools,
  connectPageTools,
  loadSettings,
  saveSettings,
  toPanelSettings,
  type PageToolsClient,
  type PanelSettings,
} from './runtime/panel-client';
import { connectRelayStatus, type RelayStatusClient } from './relay/relay-status-client';
import { createRelayStatusStore } from './relay/relay-status-store';
import {
  createSessionId,
  deriveSessionTitle,
  persistableMessages,
  type StoredChatSession,
} from './sessions/session-core';
import { initSessionStore, loadRecentSessions, saveSession } from './sessions/session-store';
import { AppHeader } from './components/AppHeader';
import { TabBar, type PanelPage } from './components/TabBar';
import { TOOL_PENDING_TEXT, type UiMessage } from './components/types';
import { ChatPage } from './pages/ChatPage';
import { DataSourcePage } from './pages/DataSourcePage';
import { A2aPage } from './pages/A2aPage';
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
      sessionRetentionLimit: 32,
      sessionLoadLimit: 8,
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

    // ---- 智能体档案 store（P1，D5/C8：领域逻辑在 core，宿主仅做 chrome.storage 适配）----
    const profileStore = createAgentProfileStore();

    // ---- 技能渐进加载（P2，D5/C8：解析编排与结果包装在 core，宿主只提供读取实现与缝注入）----
    const skillResolver = createSkillResolver(createHostSkillSource());
    const skillToolDefinition = createSkillToolDefinition();

    // ---- A2A 远程智能体（2026-09-14 解耦：全局单份配置，独立于智能体档案）----
    /** agentId → bearer token（onMounted 从 a2aTokens 存储加载；A2A 页保存时整批落盘）。 */
    const a2aTokens = reactive<Record<string, string>>({});
    /** 全局 A2A 配置（a2aConfig 存储键的响应式视图；变化即重建 A2A 工具清单）。 */
    const a2aConfig = ref<AgentA2aRef[]>([]);
    /** 保存进行中标记（A2A 页保存按钮禁用，防重复提交）。 */
    const a2aSaving = ref(false);
    const a2aHost = createA2aToolHost({
      onLog: (level, event, payload) => logEvent(level, 'chat', event, payload),
    });
    /** A2A 页全局提示（持久化失败 / 同步失败等反馈；6 秒自动清除，重复触发重置计时）。 */
    const a2aNotice = ref<{ kind: 'error' | 'ok'; text: string } | null>(null);
    let a2aNoticeTimer: ReturnType<typeof setTimeout> | null = null;
    const notifyA2a = (kind: 'error' | 'ok', text: string): void => {
      a2aNotice.value = { kind, text };
      if (a2aNoticeTimer !== null) clearTimeout(a2aNoticeTimer);
      a2aNoticeTimer = setTimeout(() => {
        a2aNotice.value = null;
        a2aNoticeTimer = null;
      }, 6000);
    };
    // 全局 A2A 配置变化（启动加载 / A2A 页保存）即重建 A2A 工具清单；
    // 同步失败（卡片抓取/配置校验）此前完全静默 —— 对话侧「没有 a2a 工具」时无从排查，现提示到 A2A 页
    watch(a2aConfig, (refs) => {
      void a2aHost.sync(refs).then((failures) => {
        if (failures.length > 0) {
          notifyA2a('error', t('msg.a2aSyncFailed', { list: joinList(failures) }));
        }
      });
    });
    /**
     * A2A 页保存（草稿 + 显式保存，与设置页同范式）：配置与 token 整批落盘，
     * 成功后更新响应式基线（watch 驱动 sync 重建工具清单）并给出成功提示。
     */
    const handleSaveA2aConfig = async (
      draftRefs: AgentA2aRef[],
      draftTokens: Record<string, string>
    ): Promise<void> => {
      if (a2aSaving.value) return;
      a2aSaving.value = true;
      try {
        await saveA2aConfig(toA2aConfigSnapshot(draftRefs));
        await saveA2aTokens({ ...draftTokens });
        // token 响应式快照对齐草稿（含清除已移除条目的 token）
        for (const key of Object.keys(a2aTokens)) {
          if (!(key in draftTokens)) delete a2aTokens[key];
        }
        Object.assign(a2aTokens, draftTokens);
        a2aConfig.value = draftRefs;
        notifyA2a('ok', t('msg.a2aConfigSaved'));
        logEvent('info', 'chat', 'a2a_config_saved', { count: draftRefs.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notifyA2a('error', t('msg.a2aSaveFailed', { message }));
        logEvent('error', 'chat', 'a2a_config_save_failed', { message });
      } finally {
        a2aSaving.value = false;
      }
    };
    /** 设置页连通测试：委托 a2a-host 按协议分派（jsonrpc 抓卡片 / dify 真实探测，不进工具清单）。 */
    const handleTestA2aConnection = (refItem: AgentA2aRef, token?: string): Promise<string> =>
      a2aHost.testConnection(refItem, token);
    /**
     * 最近一次 SKILL 调用的技能 id（SKILL 行展示用：技能 id 才是 SKILL 唯一标识，工具名只是加载器）。
     * 循环内工具串行执行，callTool 捕获 → applyEvent(result/error) 回填，时序安全。
     */
    let lastSkillLabel: string | null = null;
    /**
     * a2a__<id>__send_task / a2a_dify__<id>__send_task → 远端智能体 id（A2A 行展示用）。
     * 工具名本身携带 id，无需经 callTool 缝捕获，可同步提取（前缀随协议：jsonrpc / dify）。
     */
    const a2aAgentIdFromToolName = (name: string): string | null => {
      if (!a2aHost.handles(name)) return null;
      const prefixes = ['a2a_dify__', 'a2a__'] as const;
      for (const prefix of prefixes) {
        if (name.startsWith(prefix)) {
          return name.slice(prefix.length, name.length - '__send_task'.length);
        }
      }
      return null;
    };
    /** 激活智能体已启用技能的摘要（L1 清单数据源 = 内置 assets；storage 覆写只影响 L2 全文内容）。 */
    const enabledSkillSummaries = (): SkillSummary[] =>
      (profileStore.activeAgent.value?.skills ?? [])
        .filter((skill) => skill.enabled)
        .map((skill) => getBuiltinSkillSummary(skill.id))
        .filter((item): item is SkillSummary => item !== null);
    /** 最终组装的系统提示词（getSystemPrompt 缝与「查看提示词」共用同一实现）。 */
    const composedSystemPrompt = (): string => {
      const summaries = enabledSkillSummaries();
      const skillSection = summaries.length > 0 ? buildSkillL1Section(summaries) : undefined;
      return composeSystemPrompt(profileStore.activeAgent.value, settings.systemPrompt, {
        ...(skillSection !== undefined ? { skillSection } : {}),
      });
    };

    /** 执行锁：agent 对话或 relay 调用进行中为 true。 */
    const locked = computed(() => busy.value || relayStore.runningCount.value > 0);
    /** 锁定期间 TabBar 展示的执行提示。 */
    const phaseLabel = computed(() => {
      if (busy.value) return t('phase.agent');
      if (relayStore.runningCount.value > 0) return t('phase.relay');
      return '';
    });

    // ---- 会话历史（多会话方案，见 docs/side-panel-chat-sessions-design.md）----
    // 持久化收口 sessions/（IndexedDB 三件套）；本层只编排：归档 / 新建 / 恢复 / 自动保存。
    // 铁律（D4）：重开侧栏 / 扩展 reload / 浏览器重启 = 全新会话 —— 游标与消息全内存态，
    // setup 重跑即新游标；onMounted 禁止默认恢复任何历史会话（恢复仅由用户点击列表触发）。
    /** 当前会话 ID（侧栏打开 = 新会话，D4：空态展示最近会话列表）。 */
    const activeSessionId = ref(createSessionId());
    /** 当前会话标题（首条用户消息派生，onUserMessage 挂钩）。 */
    const activeSessionTitle = ref('');
    /** 当前会话创建时间（快照 createdAt 基准）。 */
    const activeSessionCreatedAt = ref(Date.now());
    /** 最近会话快照（打开加载 + 每次保存后刷新；空态列表数据源，已按 loadLimit 截取）。 */
    const recentSessions = ref<StoredChatSession[]>([]);

    /** 重新加载最近会话列表（条数 = sessionLoadLimit，设置保存后即时生效）。 */
    const refreshRecentSessions = async (): Promise<void> => {
      recentSessions.value = await loadRecentSessions(settings.sessionLoadLimit);
    };

    /** 组装当前会话快照（响应式数据由 saveSession 内部归一化为 plain，见 session-store）。
     *  messages 经 persistableMessages 过滤瞬态提示（修复切换会话提示累积，2026-09-18）。 */
    const buildCurrentSession = (): StoredChatSession => ({
      id: activeSessionId.value,
      title: activeSessionTitle.value,
      agentId: profileStore.activeAgentId.value,
      createdAt: activeSessionCreatedAt.value,
      updatedAt: Date.now(),
      messages: persistableMessages(messages.value),
      llmHistory: [...chatController.getHistory()],
    });

    /** 是否存在用户消息（归档守卫：仅有开场提示的会话无归档价值）。 */
    const hasUserMessage = computed(() => messages.value.some((item) => item.role === 'user'));

    /**
     * 归档任意会话快照（通用持久化入口）：saveSession 参数化、不绑定全局游标，
     * 侧栏当前会话与将来 tab-invoked 后台任务会话（runAgentLoop 自持快照）共用，
     * 并发写入由 session-store 单事务 + IndexedDB 串行调度保证。
     */
    const archiveSnapshot = async (session: StoredChatSession): Promise<void> => {
      await saveSession(session, settings.sessionRetentionLimit);
      await refreshRecentSessions();
    };

    /** 归档当前会话（无用户消息跳过）并刷新列表；locked 由各调用方守卫。 */
    const archiveCurrentSession = async (): Promise<void> => {
      if (!hasUserMessage.value) return;
      await archiveSnapshot(buildCurrentSession());
    };

    /** 重置会话游标（新建/切换智能体共用：新 ID + 清标题 + 重置创建时间）。 */
    const resetSessionCursor = (): void => {
      activeSessionId.value = createSessionId();
      activeSessionTitle.value = '';
      activeSessionCreatedAt.value = Date.now();
    };

    /** 新建会话（D1 交互）：归档当前 → 清空上下文与消息 → 新会话游标。 */
    const newSession = async (): Promise<void> => {
      if (locked.value) return;
      await archiveCurrentSession();
      chatController.clearHistory();
      messages.value = [];
      resetSessionCursor();
      pushUiMessage('assistant', t('msg.newSessionStarted'), { ephemeral: true });
      logEvent('info', 'chat', 'session_new', { sessionId: activeSessionId.value });
    };

    /** 恢复历史会话：归档当前 → 回灌 LLM 上下文（D2）与消息快照 → 切回会话智能体（D5）。 */
    const restoreSession = async (session: StoredChatSession): Promise<void> => {
      if (locked.value) return;
      await archiveCurrentSession();
      chatController.clearHistory();
      chatController.setHistory(session.llmHistory);
      // 消息以响应式代理重建（工具痕迹回填依赖响应式，同 pushUiMessage 语义）
      messages.value = session.messages.map((item) =>
        reactive<UiMessage>({ ...item, toolTrace: [...item.toolTrace] })
      );
      activeSessionId.value = session.id;
      activeSessionTitle.value = session.title;
      activeSessionCreatedAt.value = session.createdAt;
      if (session.agentId.length > 0 && profileStore.activeAgentId.value !== session.agentId) {
        await profileStore.setActive(session.agentId);
      }
      pushUiMessage('assistant', t('msg.sessionRestored', { title: session.title }), {
        ephemeral: true,
      });
      logEvent('info', 'chat', 'session_restored', { sessionId: session.id });
    };

    /** 页面路由守卫：执行锁生效期间禁止切换（TabBar 已禁用，此处兜底）。 */
    const setTab = (next: PanelPage): void => {
      if (locked.value) return;
      activeTab.value = next;
    };

    // ---- 页签反调任务宿主（C5，R4 后台运行语义）----
    // 任务与手打对话并行（Q11：无 busy 互斥）；终止按当前展示会话分派（Q13）。
    // 宿主为 Vue-free 运行时模块：活跃状态经 onTaskActivity 版本号驱动 computed 重算。
    const taskActivityVersion = ref(0);
    /**
     * 初始化快照组装缝（C6 F8）：拉取路径（宿主 init-request）与推送路径（pusher）
     * 共用。tools 按页签裁剪 —— 该页签暴露名（tab<tabId>__*）还原为裸名 + 非页签
     * 命名空间的全局工具（内置/注入）；页面 agent 只见自己页签的工具，回调经 Q6
     * 第 2 步（调用方页签前缀）解析回宿主。
     */
    const getInitSnapshot = async (tabId: number): Promise<AgentInitSnapshot> => {
      if (!pageTools) throw new Error('页面工具客户端未就绪');
      const all = await pageTools.listTools();
      const prefix = `tab${tabId}__`;
      const tabNamespace = /^tab\d+__/;
      const tools = all
        .filter((tool) => tool.name.startsWith(prefix) || !tabNamespace.test(tool.name))
        .map((tool) => ({
          name: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      return {
        agents: profileStore.agents.value,
        activeAgentId: profileStore.activeAgentId.value,
        a2aRefs: a2aConfig.value,
        skills: BUILTIN_SKILLS,
        tools,
      };
    };
    const agentTaskHost = createAgentTaskHost({
      listTools: async () => {
        if (!pageTools) throw new Error('页面工具客户端未就绪');
        const tools = await pageTools.listTools();
        toolsCount.value = tools.length;
        // 通道工具（initialization/disconnect）是协议面工具，不进任务/LLM 工具清单
        return excludeAgentChannelTools(tools);
      },
      callTool: async (name, args) => {
        if (!pageTools) throw new Error('页面工具客户端未就绪');
        return pageTools.callTool(name, args);
      },
      // C6 拉取路径：init-request → 组装载荷直接应答（无任务语义）
      getInitSnapshot,
      listAgentProfiles: () => profileStore.agents.value,
      listSkillSummaries: () => BUILTIN_SKILLS,
      getGlobalSystemPrompt: () => settings.systemPrompt,
      getLlmBaseConfig: () => ({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        apiPath: settings.apiPath,
        model: settings.model,
        apiProtocol: settings.apiProtocol,
        maxTokens: settings.maxTokens,
      }),
      archiveSession: archiveSnapshot,
      onLog: (level, event, payload) => logEvent(level, 'tasks', event, payload),
      onTaskActivity: () => {
        taskActivityVersion.value += 1;
      },
    });
    /** 当前展示会话是否为活跃任务（排队中/执行中）：驱动 TabBar「终止」按钮（Q13）。 */
    const activeTaskRunning = computed(() => {
      void taskActivityVersion.value; // 任务受理/终态时版本自增，触发重算
      return agentTaskHost.isTaskSession(activeSessionId.value);
    });

    // ---- 初始化数据推送器（C6 推送路径）----
    // 面板侧相关状态变化 → 500ms 去抖 → 向已连接且注册了初始化工具的页签推送最新载荷。
    // 订阅源：智能体档案（含 rules/技能开关等深变化）、激活智能体、A2A 配置；
    // 工具清单变化与页签连接变化在 onMounted 的 onToolsChange/onStatusChange 回调里 schedule。
    const agentInitPusher = createAgentInitPusher({
      listConnectedTabs: () => pageTools?.listConnectedTabIds() ?? [],
      getTabToolNames: async (tabId) => pageTools?.listTabToolNames(tabId) ?? [],
      callTool: async (name, args) => {
        if (!pageTools) throw new Error('页面工具客户端未就绪');
        return pageTools.callTool(name, args);
      },
      getInitSnapshot,
      onLog: (level, event, payload) => logEvent(level, 'tasks', event, payload),
    });
    watch(
      [profileStore.agents, profileStore.activeAgentId, a2aConfig],
      () => agentInitPusher.schedule(),
      { deep: true }
    );

    const pushUiMessage = (
      role: UiMessage['role'],
      content: string,
      opts?: { ephemeral?: boolean }
    ): UiMessage => {
      // 必须以响应式代理入列并返回：createTurnView 持有该对象做原位变更（onEvent 回填工具痕迹、
      // setText 写最终文案）。若返回原始对象，变更会绕过响应式 —— UI 只能等 busy 翻转才整体重绘，
      // 表现为「工具响应不立即展示，整轮结束后一次性出现」。
      // opts.ephemeral：瞬态 UI 反馈（恢复/新建/切换/设置保存等提示），归档时被 persistableMessages 过滤。
      const item = reactive<UiMessage>({
        role,
        content,
        toolTrace: [],
        ...(opts?.ephemeral ? { ephemeral: true } : {}),
      });
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

    /**
     * 把过程事件回填到助手消息的工具痕迹里（skill / a2a 类别单独标注，UI 徽标区分；
     * SKILL 行展示名回填为技能 id，A2A 行展示名回填为远端智能体 id）。
     */
    const applyEvent = (target: UiMessage, event: AgentLoopEvent): void => {
      if (event.type === 'tool_start') {
        const isSkill = event.name === SKILL_TOOL_NAME;
        const a2aAgentId = a2aAgentIdFromToolName(event.name);
        target.toolTrace.push({
          name: event.name,
          result: TOOL_PENDING_TEXT,
          failed: false,
          ...(isSkill ? { kind: 'skill' as const } : {}),
          ...(a2aAgentId !== null ? { kind: 'a2a' as const, label: a2aAgentId } : {}),
        });
        logEvent('info', 'tools', 'tool_start', { name: event.name });
        return;
      }
      if (event.type === 'tool_result' || event.type === 'tool_error') {
        const isSkill = event.name === SKILL_TOOL_NAME;
        const a2aAgentId = a2aAgentIdFromToolName(event.name);
        const capturedLabel = isSkill && lastSkillLabel !== null ? lastSkillLabel : null;
        const pending = [...target.toolTrace].reverse().find(
          (item) => item.name === event.name && item.result === TOOL_PENDING_TEXT
        );
        if (event.type === 'tool_result') {
          if (pending) {
            pending.result = event.result;
            if (capturedLabel !== null) pending.label = capturedLabel;
          } else {
            target.toolTrace.push({
              name: event.name,
              result: event.result,
              failed: false,
              ...(isSkill ? { kind: 'skill' as const } : {}),
              ...(a2aAgentId !== null ? { kind: 'a2a' as const, label: a2aAgentId } : {}),
            });
          }
          logEvent('info', 'tools', 'tool_result', { name: event.name, result: event.result });
        } else {
          if (pending) {
            pending.result = event.error;
            pending.failed = true;
            if (capturedLabel !== null) pending.label = capturedLabel;
          } else {
            target.toolTrace.push({
              name: event.name,
              result: event.error,
              failed: true,
              ...(isSkill ? { kind: 'skill' as const } : {}),
              ...(a2aAgentId !== null ? { kind: 'a2a' as const, label: a2aAgentId } : {}),
            });
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
        // 清单 = 页面工具 + 内置工具（attachBuiltinTools）+ 注入工具（attachInjectedTools：
        // __agent_load_skill / a2a__*，与调试页同源）；通道协议工具不进 LLM 清单（C6）
        const tools = await pageTools!.listTools();
        toolsCount.value = tools.length;
        return excludeAgentChannelTools(tools);
      },
      callTool: async (name, args) => {
        // 注入工具（skill / a2a）由 attachInjectedTools 层路由（与调试页同一路径），
        // 其余透传页面工具
        return pageTools!.callTool(name, args);
      },
      // per-agent LLM 覆写（P1）：全局 settings 为 base，激活智能体的 llmOverride 合并其上（领域逻辑在 core）
      getLlmConfig: () =>
        mergeLlmConfig(
          {
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            apiPath: settings.apiPath,
            model: settings.model,
            apiProtocol: settings.apiProtocol,
            maxTokens: settings.maxTokens,
          },
          profileStore.activeAgent.value?.llmOverride
        ),
      // rules 分层组装（P1）+ [skills] L1 清单（P2），领域逻辑在 core；与「查看提示词」共用实现
      getSystemPrompt: () => composedSystemPrompt(),
      getMaxHistoryTurns: () => settings.maxHistoryTurns,
      onUserMessage: (text) => {
        // 首条用户消息派生会话标题（一旦派生不再覆盖；空标题的会话不参与归档守卫之外的场景）
        if (activeSessionTitle.value.length === 0) {
          activeSessionTitle.value = deriveSessionTitle(text);
        }
        pushUiMessage('user', text);
      },
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
        pushUiMessage('assistant', t('msg.missingApiKey'), { ephemeral: true });
      },
      onMissingApiPath: () => {
        setTab('settings');
        pushUiMessage('assistant', API_PATH_EMPTY_HINT, { ephemeral: true });
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
        // 自动归档当前会话：onTurnSettled 先于 busy 翻转且终态文案已回填
        //（chat-controller finally 时序），此处拿到的 messages 即本轮终态快照
        void archiveCurrentSession();
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

    /** 全局「终止」：按当前展示会话分派（Q13）—— 任务会话终止该任务（先切到该会话）；
     *  普通会话终止 agent 对话轮 + 停止等待 relay 调用。任务与手打对话并行，两者可同时生效。 */
    const terminate = (): void => {
      if (activeTaskRunning.value) {
        const stopped = agentTaskHost.terminateTask(activeSessionId.value);
        if (stopped) {
          logEvent('info', 'tasks', 'task_terminated_by_user', { sessionId: activeSessionId.value });
        }
      }
      if (busy.value) chatController.abort();
      if (relayStore.runningCount.value > 0) {
        relayStore.terminateWait();
        logEvent('info', 'relay', 'invoke_wait_terminated', `${String(relayStore.runningCount.value)} 个调用停止等待`);
      }
    };

    // ---- 智能体切换（2026-09-18 布局调整：选择即自动归档当前会话并开新会话，无确认流程）----
    /** 切换智能体：locked 守卫 → 归档当前会话 → 清空上下文与消息 → 切换 → 新会话游标。 */
    const switchAgent = async (id: string): Promise<void> => {
      if (locked.value || id.length === 0 || id === profileStore.activeAgentId.value) return;
      await archiveCurrentSession();
      chatController.clearHistory();
      messages.value = [];
      await profileStore.setActive(id);
      resetSessionCursor();
      pushUiMessage(
        'assistant',
        t('msg.agentSwitched', { name: profileStore.activeAgent.value?.name ?? id }),
        { ephemeral: true }
      );
      logEvent('info', 'chat', 'agent_switched', { agentId: id });
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
          ? t('msg.settingsSavedConsole')
          : t('msg.settingsSaved'),
        { ephemeral: true }
      );
      await refreshTools();
    };

    // 设置页日志区块管理已下沉 SettingsPage（A3/A4 归位）：本层不再持有 logCount/hint
    // 状态与 export/clear handler，也不再用 watch(activeTab) 代刷——页面 watch(active) 自管。

    onMounted(async () => {
      // i18n：先于一切 UI 消息组装（持久化语言 / navigator.language 回退）
      await initLocale();
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
      settings.sessionRetentionLimit = loaded.sessionRetentionLimit;
      settings.sessionLoadLimit = loaded.sessionLoadLimit;
      setConsoleOutput(loaded.consoleOutput);
      // 调试模式：侧栏打开时默认进入 tools 调试页
      if (settings.debugMode) activeTab.value = 'debug';

      // 智能体档案：读存储 →（缺失/脏数据时按旧版 systemPrompt 幂等迁移）→ 需要时落盘
      // （D5/C8：迁移与校验逻辑在 core，这里只是调用 + 持久化适配）
      await profileStore.load(settings.systemPrompt);

      // 会话库：打开 + 加载最近会话列表（IndexedDB 三件套；失败静默降级为无会话功能）
      await initSessionStore();
      await refreshRecentSessions();

      // A2A token 快照加载（a2aConfig 加载后由 watch 自动首次 sync）
      const tokens = await loadA2aTokens();
      for (const [key, token] of Object.entries(tokens)) {
        a2aTokens[key] = token;
      }

      // 全局 A2A 配置加载（2026-09-14 解耦）：首启缺键时从旧 agentProfiles 一次性迁移；
      // 脏数据已备份 a2aConfig.corrupt 后重建，此处把异常结果反馈到 A2A 页
      const a2aLoaded = await loadA2aConfig();
      a2aConfig.value = a2aLoaded.refs;
      if (a2aLoaded.corrupted) {
        notifyA2a('error', t('msg.a2aConfigCorrupted'));
        logEvent('error', 'chat', 'a2a_config_corrupted_rebuilt');
      } else if (a2aLoaded.migrated) {
        logEvent('info', 'chat', 'a2a_config_migrated', {
          count: a2aLoaded.refs.length,
          dropped: a2aLoaded.migratedDropped,
        });
      }

      // 页面工具客户端 + 内置工具合成 + 注入工具层（a2a__* / __agent_load_skill）：
      // agent 对话与 tools 调试页共用同一实例（注入层与对话缝同源，调试页可直调注入工具），
      // 内置工具的「当前选中页签」直接取 relayStore 的全局选择快照
      pageTools = attachInjectedTools(attachBuiltinTools(connectPageTools(), {
        getSelectedTabIds: () => relayStore.selection.value.tabIds,
      }), {
        // 清单 = 技能加载工具（激活智能体启用技能时）+ A2A 工具（随 a2aHost.sync 维护）
        listInjected: () => [
          ...(enabledSkillSummaries().length > 0 ? [skillToolDefinition] : []),
          ...a2aHost.listTools(),
        ],
        handles: (name) => name === SKILL_TOOL_NAME || a2aHost.handles(name),
        callInjected: async (name, args) => {
          if (name === SKILL_TOOL_NAME) {
            try {
              const skillId = parseSkillToolArgs(args);
              lastSkillLabel = skillId;
              return toSkillToolResult(await skillResolver.resolve(skillId));
            } catch (error) {
              lastSkillLabel = null;
              return toSkillToolError(error instanceof Error ? error.message : String(error));
            }
          }
          return a2aHost.callTool(name, args);
        },
      });
      pageToolsRef.value = pageTools;
      unsubscribeStatus = pageTools.onStatusChange((value) => {
        const wasConnected = connected.value;
        connected.value = value;
        logEvent(value ? 'info' : 'warn', 'bridge', value ? 'bridge_connected' : 'bridge_disconnected');
        // 恢复在线即刷新清单：挂载时桥接往往未就绪，首次拉取会失败停在 0
        if (!wasConnected && value) void refreshTools();
        // 页签连接恢复 → 新页签可能需要初始化载荷（C6 推送）
        agentInitPusher.schedule();
      });
      // 页面动态注册/注销工具（桥接 toolsChanged 推送）时同步侧栏展示
      unsubscribeToolsChange = pageTools.onToolsChange(() => {
        void refreshTools();
        // 工具清单变化（页面注册/注销初始化工具）→ 推送最新载荷（C6）
        agentInitPusher.schedule();
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

      // 页签反调任务宿主：连接 SW 路由（依赖 pageTools/profileStore/settings 已就绪）
      agentTaskHost.start();

      await refreshTools();
    });

    onUnmounted(() => {
      unsubscribeStatus?.();
      unsubscribeToolsChange?.();
      agentInitPusher.dispose();
      relayStore.dispose();
      relayStatusClient?.disconnect();
      agentTaskHost.dispose();
      pageTools?.disconnect();
      pageTools = null;
    });

    // ---- 组件编排（页面级视图在 pages/，独立组件在 components/）----

    return () => (
      <div class="panel">
        <AppHeader
          connected={connected.value}
          toolsCount={toolsCount.value}
          onToggleSettings={() => {
            setTab('settings');
          }}
        />
        {/* relay 连接状态已迁入「relay 调用」页签（2026-09-18 布局调整），全局区不再展示 */}
        <TabBar
          activeTab={activeTab.value}
          locked={locked.value}
          phaseLabel={phaseLabel.value}
          showAbort={activeTaskRunning.value}
          onUpdate:activeTab={(value: PanelPage) => {
            setTab(value);
          }}
          onAbort={() => terminate()}
        />
        <ChatPage
          messages={messages.value}
          busy={busy.value}
          locked={locked.value}
          active={activeTab.value === 'chat'}
          modelValue={input.value}
          agents={profileStore.agents.value.map((item) => ({ id: item.id, name: item.name }))}
          activeAgentId={profileStore.activeAgentId.value}
          hasMessages={messages.value.length > 0}
          recentSessions={recentSessions.value}
          onUpdate:modelValue={(value: string) => {
            input.value = value;
          }}
          onSend={() => void send()}
          onSwitchAgent={(id: string) => void switchAgent(id)}
          onNewSession={() => void newSession()}
          onRestoreSession={(session: StoredChatSession) => void restoreSession(session)}
        />
        {pageToolsRef.value ? (
          <DebugPage
            pageTools={pageToolsRef.value}
            active={activeTab.value === 'debug'}
            locked={locked.value}
            onHandoff={(run: DebugRun) => {
              void handleHandoff(run);
            }}
          />
        ) : null}
        <RelayPage
          active={activeTab.value === 'relay'}
          statuses={relayStore.statuses.value}
          invokeLogs={relayStore.invokeLogs.value}
          runningCount={relayStore.runningCount.value}
          terminated={relayStore.terminated.value}
        />
        <DataSourcePage
          active={activeTab.value === 'datasource'}
          statuses={relayStore.statuses.value}
          selection={relayStore.selection.value}
          locked={locked.value}
          relayStatus={relayStatusClient}
        />
        <A2aPage
          active={activeTab.value === 'a2a'}
          refs={a2aConfig.value}
          a2aTokens={a2aTokens}
          busy={locked.value}
          saving={a2aSaving.value}
          testConnection={handleTestA2aConnection}
          notice={a2aNotice.value}
          onSave={(refs: AgentA2aRef[], tokens: Record<string, string>) =>
            void handleSaveA2aConfig(refs, tokens)}
        />
        <SettingsPage
          active={activeTab.value === 'settings'}
          settings={settings}
          busy={locked.value}
          // 表单编辑只落 SettingsForm 本地草稿（编辑态/只读态拆分）：保存时草稿合并进
          // 基线 reactive 对象，再走既有 persistSettings 落盘 + setTab('chat') 流程
          onSave={(draft: PanelSettings) => {
            Object.assign(settings, draft);
            void persistSettings();
          }}
        />
      </div>
    );
  },
});
