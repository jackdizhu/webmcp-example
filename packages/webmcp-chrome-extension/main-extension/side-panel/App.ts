// 侧边栏根组件（Vue 3 + TypeScript）——纯编排层。
//
// 职责边界：全局状态（设置/消息/页面路由/连接/调用日志）、agent 轮次编排（runTurn +
// 终止）、执行锁（agent 对话或 relay 调用进行中禁止切换页面）、traceId 与日志埋点、
// 生命周期（Port 桥接连断）。渲染全部下沉到 components/ 与 pages/（h() 渲染函数，
// MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { computed, defineComponent, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  API_PATH_EMPTY_HINT,
  buildSkillL1Section,
  composeSystemPrompt,
  createChatController,
  createSkillResolver,
  createSkillToolDefinition,
  mergeLlmConfig,
  parseSkillToolArgs,
  SKILL_TOOL_NAME,
  toSkillToolError,
  toSkillToolResult,
  type AgentLoopEvent,
  type SkillSummary,
} from 'webmcp-agent-chat-core';
import { createAgentProfileStore } from './agent-profile-store';
import { createHostSkillSource, getBuiltinSkillSummary } from './skill-assets';
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

    // ---- 智能体档案 store（P1，D5/C8：领域逻辑在 core，宿主仅做 chrome.storage 适配）----
    const profileStore = createAgentProfileStore();
    /** 待确认切换的智能体 ID（空串 = 无待确认；确认条在 ChatPage 渲染）。 */
    const pendingSwitchAgentId = ref('');

    // ---- 技能渐进加载（P2，D5/C8：解析编排与结果包装在 core，宿主只提供读取实现与缝注入）----
    const skillResolver = createSkillResolver(createHostSkillSource());
    const skillToolDefinition = createSkillToolDefinition();
    /**
     * 最近一次 SKILL 调用的技能 id（SKILL 行展示用：技能 id 才是 SKILL 唯一标识，工具名只是加载器）。
     * 循环内工具串行执行，callTool 捕获 → applyEvent(result/error) 回填，时序安全。
     */
    let lastSkillLabel: string | null = null;
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
      // 必须以响应式代理入列并返回：createTurnView 持有该对象做原位变更（onEvent 回填工具痕迹、
      // setText 写最终文案）。若返回原始对象，变更会绕过响应式 —— UI 只能等 busy 翻转才整体重绘，
      // 表现为「工具响应不立即展示，整轮结束后一次性出现」。
      const item = reactive<UiMessage>({ role, content, toolTrace: [] });
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
     * 把过程事件回填到助手消息的工具痕迹里（skill 类别单独标注，UI 徽标区分；
     * SKILL 行展示名回填为技能 id —— tool_start 事件无 args，id 由 callTool 缝在执行时捕获）。
     */
    const applyEvent = (target: UiMessage, event: AgentLoopEvent): void => {
      if (event.type === 'tool_start') {
        const isSkill = event.name === SKILL_TOOL_NAME;
        target.toolTrace.push({
          name: event.name,
          result: TOOL_PENDING_TEXT,
          failed: false,
          ...(isSkill ? { kind: 'skill' as const } : {}),
        });
        logEvent('info', 'tools', 'tool_start', { name: event.name });
        return;
      }
      if (event.type === 'tool_result' || event.type === 'tool_error') {
        const isSkill = event.name === SKILL_TOOL_NAME;
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
              ...(capturedLabel !== null ? { label: capturedLabel } : {}),
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
              ...(capturedLabel !== null ? { label: capturedLabel } : {}),
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
        // 清单含内置工具（chrome_extension_*，由 attachBuiltinTools 合成）
        const tools = await pageTools!.listTools();
        // P2：激活智能体启用了技能时追加 __agent_load_skill（D6 注入点；调试页/relay 的 pageTools 不受影响）
        const appendSkillTool =
          enabledSkillSummaries().length > 0 && !tools.some((tool) => tool.name === SKILL_TOOL_NAME);
        toolsCount.value = tools.length + (appendSkillTool ? 1 : 0);
        return appendSkillTool ? [...tools, skillToolDefinition] : tools;
      },
      callTool: async (name, args) => {
        // P2：__agent_load_skill 经宿主缝本地路由（core 解析编排 + 结果包装），其余透传页面工具
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

    // ---- 智能体切换（D4：确认后清空历史开新会话；locked 期间禁止发起）----
    /** 确认条展示名（由待确认 ID 反查）。 */
    const pendingSwitchName = computed(
      () => profileStore.agents.value.find((item) => item.id === pendingSwitchAgentId.value)?.name ?? ''
    );
    const requestSwitchAgent = (id: string): void => {
      if (locked.value || id.length === 0 || id === profileStore.activeAgentId.value) return;
      pendingSwitchAgentId.value = id;
    };
    const confirmSwitchAgent = async (): Promise<void> => {
      const id = pendingSwitchAgentId.value;
      if (id.length === 0 || locked.value) return;
      // 开新会话：清跨轮历史（controller）+ 清 UI 消息（D4 领域规则在 core，UI 清空属宿主展示层）
      chatController.clearHistory();
      messages.value = [];
      pendingSwitchAgentId.value = '';
      await profileStore.setActive(id);
      pushUiMessage('assistant', `已切换到「${profileStore.activeAgent.value?.name ?? id}」，已开启新会话。`);
      logEvent('info', 'chat', 'agent_switched', { agentId: id });
    };
    const cancelSwitchAgent = (): void => {
      pendingSwitchAgentId.value = '';
    };

    /** ChatPage「查看提示词」：把最终组装的系统提示词以消息形式展示（P2 轻量实现，含段来源标注）。 */
    const inspectPrompt = (): void => {
      if (locked.value) return;
      const prompt = composedSystemPrompt();
      pushUiMessage(
        'assistant',
        prompt.length > 0
          ? `当前系统提示词（分层组装，含段来源标注）：\n\n${prompt}`
          : '当前系统提示词为空，将使用内置默认提示词。'
      );
      logEvent('info', 'chat', 'system_prompt_inspected');
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

      // 智能体档案：读存储 →（缺失/脏数据时按旧版 systemPrompt 幂等迁移）→ 需要时落盘
      // （D5/C8：迁移与校验逻辑在 core，这里只是调用 + 持久化适配）
      await profileStore.load(settings.systemPrompt);

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
          agents: profileStore.agents.value.map((item) => ({ id: item.id, name: item.name })),
          activeAgentId: profileStore.activeAgentId.value,
          pendingSwitchName: pendingSwitchName.value,
          'onUpdate:modelValue': (value: string) => {
            input.value = value;
          },
          onSend: () => void send(),
          onSwitchAgent: (id: string) => requestSwitchAgent(id),
          onConfirmSwitch: () => void confirmSwitchAgent(),
          onCancelSwitch: () => cancelSwitchAgent(),
          onInspectPrompt: () => inspectPrompt(),
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
