// 页签反调任务的侧边栏宿主（C5 反向通道第 4 跳，执行主场 = 侧栏扩展页）。
//
// 职责（探索文档 §4 / §4.5 / §4.6）：
// - 连接 SW 路由（AGENT_TASK_HOST_PORT_NAME），接收注入了可信 sender 的 create-task；
// - 受理校验：入参（validateAgentTaskPayload）→ 智能体解析（resolveAgentProfile）→
//   技能解析（resolveSkillSummary，Q7）→ 每 agent 队列容量（Q9：5）→ 受理回执 task-ack；
// - 执行（R4 后台语义）：runAgentTask 直连（不经 chatController），新会话 + 后台运行，
//   与侧栏手打对话并行（Q11：任务间 FIFO 串行、与手打对话并行、无 busy 互斥）；
// - 会话集成：任务开始即以 running 状态归档（Q12），终态覆写归档；
//   origin/taskStatus 写入 StoredChatSession（SessionList 徽标数据源）；
// - 终止分派（Q13）：terminateTask(sessionId) 由 App 在「当前展示会话 = 运行中任务」时调用；
// - 超时（Q9）：agent 任务 10 分钟、tool 任务 30 秒 → 终态 failed（result.code = TASK_TIMED_OUT）；
// - init 拉取（C6）：init-request 直接应答 init-data，无任务语义 —— 不建会话、不进队列、
//   无徽标；载荷经 chat-core buildAgentInitPayload 统一组装（与推送路径同源）。
//
// 隔离红线（§4.6）：不触碰 trace-context 模块级单值（setCurrentTrace 属手打对话轮）；
// 不写 lastSkillLabel 缝；任务日志以 taskId 贯穿（onLog → logEvent 'tasks' 域）。
// SW 重启语义：Port 断开后定时重连；重连前的终态应答会被 SW（映射已清空）丢弃 ——
// 页面侧此时已经由 CS 桥接补偿收到 EXTENSION_HOST_UNAVAILABLE，终态仍会归档到会话。
import {
  AGENT_TASK_HOST_PORT_NAME,
  createTaskId,
  validateAgentTaskPayload,
  type AgentTaskErrorMessage,
  type AgentTaskHostReplyMessage,
  type AgentTaskInput,
  type AgentTaskRoutedCreateMessage,
  type AgentTaskRoutedInitRequestMessage,
  type TaskTerminalStatus,
} from '../../../core/agent-task-protocol';
import { serializeToolResult } from '../../../core/page-tools-bridge';
import {
  AgentAbortError,
  AgentTaskRunnerError,
  buildAgentInitPayload,
  createLlmClient,
  mergeLlmConfig,
  resolveAgentProfile,
  resolveSkillSummary,
  runAgentTask,
  type AgentLoopEvent,
  type AgentInitSnapshot,
  type AgentProfile,
  type AgentTool,
  type ChatMessage,
  type LlmChatClient,
  type LlmConfig,
  type LlmLogFn,
  type SkillSummary,
} from 'webmcp-agent-chat-core';
import { createSessionId, deriveSessionTitle, type StoredChatSession } from '../sessions/session-core';
import { TOOL_PENDING_TEXT, type ToolTraceItem, type UiMessage } from '../components/types';

/** agent 任务超时（Q9：10 分钟）。 */
const AGENT_TASK_TIMEOUT_MS = 10 * 60_000;
/** tool 任务超时（Q9：30 秒）。 */
const TOOL_TASK_TIMEOUT_MS = 30_000;
/** 每 agent 队列容量上限（Q9：5，含正在执行的那一个）。 */
const QUEUE_CAP_PER_AGENT = 5;
/** 宿主 Port 断线重连间隔（SW 重启/休眠后恢复路由）。 */
const HOST_RECONNECT_DELAY_MS = 5_000;

/** 宿主依赖（App 注入；全部为缝函数，便于单测替换）。 */
export interface AgentTaskHostDeps {
  /** 当前全量工具清单（页面工具 + 内置 + 注入，每次执行时实时拉取）。 */
  listTools: () => Promise<AgentTool[]>;
  /** 单工具执行器（注入层路由 + 页面工具透传，与手打对话同缝）。 */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 智能体档案快照（受理时解析目标）。 */
  listAgentProfiles: () => AgentProfile[];
  /** 可用技能摘要（skillName 解析域：内置技能清单 + 覆写同名条目）。 */
  listSkillSummaries: () => readonly SkillSummary[];
  /** 全局 rules 提示词（settings.systemPrompt）。 */
  getGlobalSystemPrompt: () => string;
  /**
   * 初始化快照组装缝（C6）：按调用方 tabId 返回快照（App 侧按页签裁剪 tools），
   * 仅 init 拉取/推送使用，不触碰任务链；载荷由宿主经 buildAgentInitPayload 统一组装。
   */
  getInitSnapshot: (tabId: number) => Promise<AgentInitSnapshot>;
  /** LLM 基础配置（全局 settings；per-agent llmOverride 由宿主内部 mergeLlmConfig）。 */
  getLlmBaseConfig: () => LlmConfig;
  /** LLM 客户端工厂（缺省 createLlmClient；单测注入桩用）。 */
  createLlm?: (config: LlmConfig) => LlmChatClient;
  /** 会话归档缝（App 的 archiveSnapshot：saveSession + 列表刷新）。 */
  archiveSession: (session: StoredChatSession) => Promise<void>;
  /** 日志缝（logEvent，'tasks' 域；payload 不含鉴权数据）。 */
  onLog: LlmLogFn;
  /** 任务活跃状态变化通知（App 借此驱动「终止」按钮可见性重算）。 */
  onTaskActivity: () => void;
}

/** 运行中/排队中的任务记录（sessionId 索引）。 */
interface ActiveTask {
  taskId: string;
  requestId: string;
  sessionId: string;
  /** agent 任务的队列键（profile.id）；tool 任务无队列。 */
  profileId: string | null;
  input: AgentTaskInput;
  sender: { tabId: number; origin: string };
  /** 技能摘要（skillName 命中时；无技能任务为 null）。 */
  skillSummary: SkillSummary | null;
  /** running 态会话快照（终态时原位更新后归档）。 */
  session: StoredChatSession;
  /** 执行中的终止控制器（排队任务为 null）。 */
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 超时触发标记（abort 原因区分：超时 → failed/TASK_TIMED_OUT，用户 → cancelled）。 */
  timedOut: boolean;
}

/** SW → 宿主 create-task 的结构守卫（sender 由 SW 注入，缺失即协议不符）。 */
function isRoutedCreate(value: unknown): value is AgentTaskRoutedCreateMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'create-task' || typeof record['requestId'] !== 'string') return false;
  const sender = record['sender'];
  if (typeof sender !== 'object' || sender === null) return false;
  const s = sender as Record<string, unknown>;
  return typeof s['tabId'] === 'number' && typeof s['origin'] === 'string';
}

/** SW → 宿主 init-request 的结构守卫（C6；sender 语义同 isRoutedCreate）。 */
function isRoutedInitRequest(value: unknown): value is AgentTaskRoutedInitRequestMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'init-request' || typeof record['requestId'] !== 'string') return false;
  const sender = record['sender'];
  if (typeof sender !== 'object' || sender === null) return false;
  const s = sender as Record<string, unknown>;
  return typeof s['tabId'] === 'number' && typeof s['origin'] === 'string';
}

/** 消费 chrome.runtime.lastError（同 panel-client 口径）。 */
function consumeRuntimeLastError(): string | undefined {
  const chromeGlobal = (globalThis as {
    chrome?: { runtime?: { lastError?: { message?: string } } };
  }).chrome;
  return chromeGlobal?.runtime?.lastError?.message;
}

/** Q6 工具名 4 步解析：精确 → 调用方页签前缀 → 唯一后缀 → 歧义/未找到。 */
export function resolveToolName(
  requested: string,
  callerTabId: number,
  availableNames: readonly string[]
): { ok: true; name: string } | { ok: false; code: 'TOOL_NOT_FOUND' | 'AMBIGUOUS_TOOL_NAME'; message: string } {
  if (availableNames.includes(requested)) return { ok: true, name: requested };
  const tabPrefixed = `tab${callerTabId}__${requested}`;
  if (availableNames.includes(tabPrefixed)) return { ok: true, name: tabPrefixed };
  const suffixMatches = availableNames.filter(
    (name) => name.endsWith(`__${requested}`) || name.endsWith(`_${requested}`)
  );
  if (suffixMatches.length === 1) {
    const match = suffixMatches[0];
    return match !== undefined ? { ok: true, name: match } : { ok: false, code: 'TOOL_NOT_FOUND', message: `未找到工具：${requested}` };
  }
  if (suffixMatches.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_TOOL_NAME',
      message: `工具名「${requested}」匹配到 ${suffixMatches.length} 个候选（${suffixMatches.join(', ')}），请使用完整工具名`,
    };
  }
  return { ok: false, code: 'TOOL_NOT_FOUND', message: `未找到工具：${requested}` };
}

/**
 * 创建任务宿主。Port 工厂可注入（单测用桩 Port 驱动受理/应答断言）。
 */
export function createAgentTaskHost(
  deps: AgentTaskHostDeps,
  portFactory: () => chrome.runtime.Port = () => chrome.runtime.connect({ name: AGENT_TASK_HOST_PORT_NAME })
): {
  start: () => void;
  dispose: () => void;
  /** 该会话是否为活跃任务（排队中或执行中）；App 驱动「终止」按钮可见性。 */
  isTaskSession: (sessionId: string) => boolean;
  /** 终止指定会话的任务（Q13）：执行中 → abort（cancelled）；排队中 → 直接出队取消。 */
  terminateTask: (sessionId: string) => boolean;
} {
  const activeTasks = new Map<string, ActiveTask>();
  /** 每 agent FIFO 队列（Q11：任务间串行；tool 任务不入队、即时执行）。 */
  const queues = new Map<string, { items: ActiveTask[]; running: boolean }>();
  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const reply = (message: AgentTaskHostReplyMessage): void => {
    if (port === null) return;
    try {
      port.postMessage(message);
    } catch {
      // SW 重启竞态：Port 已死，应答丢弃（页面侧已由 CS 桥接补偿）
    }
  };

  const failRequest = (requestId: string, code: AgentTaskErrorMessage['code'], message: string): void => {
    reply({ type: 'task-error', requestId, code, message } satisfies AgentTaskErrorMessage);
  };

  /** 终态收口：更新会话快照 → 归档 → 回发 task-done → 清理活跃表。 */
  const finishTask = (
    task: ActiveTask,
    status: TaskTerminalStatus,
    result: unknown,
    patch: { messages: UiMessage[]; llmHistory: ChatMessage[] }
  ): void => {
    if (task.timer !== null) clearTimeout(task.timer);
    task.session.taskStatus = status;
    task.session.updatedAt = Date.now();
    task.session.messages = patch.messages;
    task.session.llmHistory = patch.llmHistory;
    activeTasks.delete(task.sessionId);
    deps.onTaskActivity();
    void deps.archiveSession({ ...task.session, messages: [...patch.messages], llmHistory: [...patch.llmHistory] })
      .catch((error: unknown) => {
        deps.onLog('error', 'task_archive_failed', {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    deps.onLog('info', 'task_terminal', {
      taskId: task.taskId,
      sessionId: task.sessionId,
      status,
      origin: task.sender.origin,
    });
    reply({
      type: 'task-done',
      requestId: task.requestId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      status,
      result,
    });
  };

  /** 执行失败/终止的统一终态结果载荷（code 随 result 透出，页面按需分支）。 */
  const failureResult = (code: string, message: string): { code: string; error: string } => ({
    code,
    error: message,
  });

  /** agent 任务执行体（队列 pump 调用；含超时与终止语义）。 */
  const runAgentTaskItem = async (task: ActiveTask, profile: AgentProfile): Promise<void> => {
    const controller = new AbortController();
    task.controller = controller;
    task.timer = setTimeout(() => {
      task.timedOut = true;
      controller.abort();
    }, AGENT_TASK_TIMEOUT_MS);
    const trace: ToolTraceItem[] = [];
    const onEvent = (event: AgentLoopEvent): void => {
      if (event.type === 'llm_call') return;
      if (event.type === 'tool_start') {
        trace.push({ name: event.name, result: TOOL_PENDING_TEXT, failed: false });
        return;
      }
      const pending = [...trace].reverse().find((item) => item.name === event.name && item.result === TOOL_PENDING_TEXT);
      if (event.type === 'tool_result') {
        if (pending) {
          pending.result = event.result;
        } else {
          trace.push({ name: event.name, result: event.result, failed: false });
        }
        return;
      }
      if (event.type === 'tool_error') {
        if (pending) {
          pending.result = event.error;
          pending.failed = true;
        } else {
          trace.push({ name: event.name, result: event.error, failed: true });
        }
      }
    };
    try {
      const tools = await deps.listTools();
      const llm = (deps.createLlm ?? createLlmClient)(
        mergeLlmConfig(deps.getLlmBaseConfig(), profile.llmOverride)
      );
      const result = await runAgentTask({
        profile,
        prompt: task.input.taskType === 'agent' ? task.input.agentPrompt : '',
        deps: {
          llm,
          tools,
          executeTool: deps.callTool,
          globalSystemPrompt: deps.getGlobalSystemPrompt(),
          onEvent,
          signal: controller.signal,
        },
        ...(task.skillSummary !== null ? { skillSummary: task.skillSummary } : {}),
      });
      const messages: UiMessage[] = [
        { role: 'user', content: task.input.taskType === 'agent' ? task.input.agentPrompt : '', toolTrace: [] },
        { role: 'assistant', content: result.text, toolTrace: trace },
      ];
      finishTask(task, 'completed', result.text, { messages, llmHistory: result.transcript });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (task.timedOut) {
        finishTask(task, 'failed', failureResult('TASK_TIMED_OUT', `任务超时（${AGENT_TASK_TIMEOUT_MS}ms）`), {
          messages: [
            { role: 'user', content: task.input.taskType === 'agent' ? task.input.agentPrompt : '', toolTrace: [] },
            { role: 'assistant', content: `任务超时（${AGENT_TASK_TIMEOUT_MS}ms）`, toolTrace: trace },
          ],
          llmHistory: [],
        });
        return;
      }
      if (error instanceof AgentAbortError) {
        finishTask(task, 'cancelled', failureResult('CANCELLED', '任务已被用户终止'), {
          messages: [
            { role: 'user', content: task.input.taskType === 'agent' ? task.input.agentPrompt : '', toolTrace: [] },
            { role: 'assistant', content: '任务已被用户终止', toolTrace: trace },
          ],
          llmHistory: [],
        });
        return;
      }
      deps.onLog('error', 'task_execution_failed', { taskId: task.taskId, error: message });
      finishTask(task, 'failed', failureResult('EXECUTION_FAILED', message), {
        messages: [
          { role: 'user', content: task.input.taskType === 'agent' ? task.input.agentPrompt : '', toolTrace: [] },
          { role: 'assistant', content: `执行异常：${message}`, toolTrace: trace },
        ],
        llmHistory: [],
      });
    } finally {
      task.controller = null;
      if (task.timer !== null) {
        clearTimeout(task.timer);
        task.timer = null;
      }
      if (task.profileId !== null) {
        const entry = queues.get(task.profileId);
        if (entry) {
          entry.running = false;
          pump(task.profileId);
        }
      }
    }
  };

  /** 队列泵：串行取队首执行（Q11）。 */
  const pump = (profileId: string): void => {
    const entry = queues.get(profileId);
    if (!entry || entry.running || entry.items.length === 0) return;
    const task = entry.items.shift();
    if (!task) return;
    entry.running = true;
    // 执行前重查档案（规则/llmOverride 可能已变化；档案被删则按执行失败终态）
    const profile = deps.listAgentProfiles().find((item) => item.id === profileId);
    if (!profile) {
      entry.running = false;
      finishTask(task, 'failed', failureResult('AGENT_NOT_FOUND', `智能体 ${profileId} 已不存在`), {
        messages: [{ role: 'assistant', content: `智能体 ${profileId} 已不存在，任务未执行`, toolTrace: [] }],
        llmHistory: [],
      });
      pump(profileId);
      return;
    }
    deps.onLog('info', 'task_started', { taskId: task.taskId, sessionId: task.sessionId, agentId: profileId });
    void runAgentTaskItem(task, profile);
  };

  /** tool 任务执行体（不入队，即时执行；30s 超时）。 */
  const runToolTaskItem = async (task: ActiveTask): Promise<void> => {
    const input = task.input;
    if (input.taskType !== 'tool') return;
    const timer = setTimeout(() => {
      task.timedOut = true;
      task.controller?.abort();
    }, TOOL_TASK_TIMEOUT_MS);
    task.timer = timer;
    const controller = new AbortController();
    task.controller = controller;
    try {
      const tools = await deps.listTools();
      const resolved = resolveToolName(input.toolName, task.sender.tabId, tools.map((tool) => tool.name));
      if (!resolved.ok) {
        finishTask(task, 'failed', failureResult(resolved.code, resolved.message), {
          messages: [{ role: 'assistant', content: resolved.message, toolTrace: [] }],
          llmHistory: [],
        });
        return;
      }
      const startedAt = Date.now();
      const result = await deps.callTool(resolved.name, input.toolProps);
      if (task.timedOut) throw new Error(`任务超时（${TOOL_TASK_TIMEOUT_MS}ms）`);
      const serialized = serializeToolResult(result);
      deps.onLog('info', 'tool_task_done', {
        taskId: task.taskId,
        tool: resolved.name,
        elapsedMs: Date.now() - startedAt,
      });
      finishTask(task, 'completed', result, {
        messages: [
          {
            role: 'assistant',
            content: `工具 ${resolved.name} 执行完成`,
            toolTrace: [{ name: resolved.name, result: serialized, failed: false }],
          },
        ],
        llmHistory: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (task.timedOut) {
        finishTask(task, 'failed', failureResult('TASK_TIMED_OUT', `任务超时（${TOOL_TASK_TIMEOUT_MS}ms）`), {
          messages: [{ role: 'assistant', content: `任务超时（${TOOL_TASK_TIMEOUT_MS}ms）`, toolTrace: [] }],
          llmHistory: [],
        });
        return;
      }
      finishTask(task, 'failed', failureResult('EXECUTION_FAILED', message), {
        messages: [
          {
            role: 'assistant',
            content: `工具执行异常：${message}`,
            toolTrace: [{ name: input.toolName, result: message, failed: true }],
          },
        ],
        llmHistory: [],
      });
    } finally {
      task.controller = null;
      if (task.timer !== null) {
        clearTimeout(task.timer);
        task.timer = null;
      }
    }
  };

  /** 受理一个 create-task：校验 → 解析 → 队列容量 → 会话建档 → ack → 入队/执行。 */
  const acceptTask = (routed: AgentTaskRoutedCreateMessage): void => {
    const validation = validateAgentTaskPayload(routed.payload);
    if (!validation.ok) {
      failRequest(routed.requestId, validation.code, validation.message);
      return;
    }
    const input = validation.input;
    let skillSummary: SkillSummary | null = null;
    let profileId: string | null = null;
    if (input.taskType === 'agent') {
      try {
        const profile = resolveAgentProfile(
          deps.listAgentProfiles(),
          input.agentId !== undefined ? { agentId: input.agentId } : { agentName: input.agentName }
        );
        profileId = profile.id;
        if (input.skillName !== undefined) {
          skillSummary = resolveSkillSummary(deps.listSkillSummaries(), input.skillName);
        }
      } catch (error) {
        if (error instanceof AgentTaskRunnerError) {
          failRequest(routed.requestId, error.code, error.message);
          return;
        }
        failRequest(routed.requestId, 'EXECUTION_FAILED', error instanceof Error ? error.message : String(error));
        return;
      }
    }
    // 队列容量（Q9）：按 profile 维度计数（排队 + 执行中）
    if (profileId !== null) {
      const entry = queues.get(profileId) ?? { items: [], running: false };
      queues.set(profileId, entry);
      if (entry.items.length + (entry.running ? 1 : 0) >= QUEUE_CAP_PER_AGENT) {
        failRequest(routed.requestId, 'QUEUE_FULL', `智能体「${profileId}」的任务队列已满（${QUEUE_CAP_PER_AGENT}），请稍后重试`);
        return;
      }
    }
    const prompt = input.taskType === 'agent' ? input.agentPrompt : input.toolName;
    const now = Date.now();
    const session: StoredChatSession = {
      id: createSessionId(),
      title: deriveSessionTitle(prompt) || prompt.slice(0, 20),
      // tool 任务无智能体归属：agentId 留空（restoreSession 对空 agentId 跳过 setActive）
      agentId: profileId ?? '',
      createdAt: now,
      updatedAt: now,
      messages:
        input.taskType === 'agent'
          ? [{ role: 'user', content: input.agentPrompt, toolTrace: [] }]
          : [],
      llmHistory: [],
      origin: routed.sender.origin,
      taskStatus: 'running',
    };
    const task: ActiveTask = {
      taskId: createTaskId(),
      requestId: routed.requestId,
      sessionId: session.id,
      profileId,
      input,
      sender: routed.sender,
      skillSummary,
      session,
      controller: null,
      timer: null,
      timedOut: false,
    };
    activeTasks.set(session.id, task);
    deps.onTaskActivity();
    deps.onLog('info', 'task_accepted', {
      taskId: task.taskId,
      sessionId: session.id,
      taskType: input.taskType,
      tabId: routed.sender.tabId,
      origin: routed.sender.origin,
    });
    reply({
      type: 'task-ack',
      requestId: routed.requestId,
      taskId: task.taskId,
      sessionId: session.id,
    });
    // Q12：开始即归档 running 快照（会话列表立刻可见「运行中」）
    void deps.archiveSession({ ...session, messages: [...session.messages] });
    if (input.taskType === 'tool') {
      void runToolTaskItem(task);
      return;
    }
    if (profileId !== null) {
      // 先入队（FIFO）再泵：pump 空闲即取队首执行，否则等当前任务 finally 再泵
      queues.get(profileId)?.items.push(task);
      pump(profileId);
    }
  };

  /** 处理 init-request（C6 拉取路径）：组装载荷直接应答 init-data，无任务语义。 */
  const handleInitRequest = async (routed: AgentTaskRoutedInitRequestMessage): Promise<void> => {
    try {
      const snapshot = await deps.getInitSnapshot(routed.sender.tabId);
      reply({ type: 'init-data', requestId: routed.requestId, payload: buildAgentInitPayload(snapshot) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.onLog('error', 'agent_init_fetch_failed', { tabId: routed.sender.tabId, error: message });
      failRequest(routed.requestId, 'EXECUTION_FAILED', '初始化数据组装失败，请稍后重试');
    }
  };

  const connect = (): void => {
    if (disposed) return;
    const fresh = portFactory();
    fresh.onMessage.addListener((message: unknown) => {
      if (isRoutedCreate(message)) {
        acceptTask(message);
        return;
      }
      if (isRoutedInitRequest(message)) {
        void handleInitRequest(message);
      }
    });
    fresh.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      if (port === fresh) port = null;
      if (!disposed && reconnectTimer === null) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, HOST_RECONNECT_DELAY_MS);
      }
    });
    port = fresh;
  };

  return {
    start: () => {
      connect();
    },
    dispose: () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const task of activeTasks.values()) {
        if (task.timer !== null) clearTimeout(task.timer);
        task.controller?.abort();
      }
      activeTasks.clear();
      queues.clear();
      port?.disconnect();
      port = null;
    },
    isTaskSession: (sessionId) => activeTasks.has(sessionId),
    terminateTask: (sessionId) => {
      const task = activeTasks.get(sessionId);
      if (!task) return false;
      // 排队中：出队 + 直接终态；执行中：abort（AgentAbortError → cancelled）
      if (task.controller === null && task.profileId !== null) {
        const entry = queues.get(task.profileId);
        if (entry) {
          const index = entry.items.indexOf(task);
          if (index >= 0) entry.items.splice(index, 1);
        }
        finishTask(task, 'cancelled', failureResult('CANCELLED', '任务在队列中被终止'), {
          messages: [{ role: 'assistant', content: '任务在队列中被终止', toolTrace: [] }],
          llmHistory: [],
        });
        return true;
      }
      task.controller?.abort();
      return true;
    },
  };
}
