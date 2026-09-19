// Worker 线程消息处理器（纯逻辑可测）：主线程消息分派 → chat 直调 / run-agent 循环。
// 设计文档：docs/web-agent-worker-explore.md §3.2（chat 基线）+ §9.4/§9.5/§9.13（run-agent）。
//
// 职责边界：
// - chat：组包（配置级 + 调用级合并）→ dify-client（超时/解析）→ 按 format 组装
//   chunk 流（'sse'）或聚合 done（'json'）；远端 blocking JSON 时无论 format 直接 done；
// - run-agent：并发槽（上限 AGENT_MAX_CONCURRENCY，满则 agent-busy 拒绝）→ 装配
//   runAgentLoop（dify 工具 + 临时工具）→ 临时工具经反向协议 tool-call/tool-result 往返
//   （worker 侧 60s 超时兜底 + 自动从 LLM 清单移除）→ done(kind agent) 终态；
// - cancel：按 requestId 精确 abort（省略 = 全部在途），终态统一 error(cancelled)。
import { createDifyClient, type DifyClient } from '../dify/dify-client';
import { buildDifyChatTool, type DifyChatTool } from '../dify/dify-tool';
import { createCallLogger, type CallLogger } from '../logging/call-logger';
import { truncateContent } from '../logging/logger-core';
import type { CallLogEntry, CallLogPhase, LogStorage } from '../logging/logger-types';
import { AgentAbortError, runAgentLoop, type AgentTool, type LlmChatClient } from '../loop/agent-loop';
import { createLlmClient, type LlmConfig, type LlmLogFn } from '../loop/llm-client';
import type {
  MainToWorkerMessage,
  WebAgentRunAgentInput,
  WebAgentTempToolDef,
  WebAgentWorkerConfig,
  WebAgentWorkerErrorCode,
  WorkerToMainMessage,
} from '../protocol';
import { WebAgentWorkerError, validateMainToWorkerMessage } from '../protocol';

/** agent 任务最大并发数（V6 定案；超出立即 agent-busy 拒绝，无等待队列）。 */
export const AGENT_MAX_CONCURRENCY = 3;
/** 临时工具执行超时（V4 定案：worker 侧计时；超时 isError 回填并移除该工具）。 */
export const TEMP_TOOL_TIMEOUT_MS = 60_000;
/** 并发满时的拒绝文案（对齐 a2a-tool-source 串行守卫的拒绝语义）。 */
export const AGENT_BUSY_MESSAGE = `已有 ${AGENT_MAX_CONCURRENCY} 个智能体任务在执行，请等待完成后再发起`;

const noopLog: LlmLogFn = () => {};

/** worker 侧依赖（post 为发往主线程的出口；fetchImpl/onLog/logStorage 注入便于测试）。 */
export interface WorkerHandleDeps {
  post: (message: WorkerToMainMessage) => void;
  fetchImpl: typeof fetch;
  onLog?: LlmLogFn | undefined;
  /** 调用日志存储（缺省未接入，日志器为 no-op 零开销）。 */
  logStorage?: LogStorage | undefined;
}

/** 临时工具等待回执的挂起项（tool-result 晚到按 toolCallId 出表忽略）。 */
interface PendingToolCall {
  name: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (content: string) => void;
  reject: (error: Error) => void;
}

/** agent 任务运行时（隔离单元：AbortController / 临时工具表 / 挂起回执互不可见）。 */
interface AgentRuntime {
  controller: AbortController;
  tempTools: Map<string, WebAgentTempToolDef>;
  removedTempTools: Set<string>;
  pendingToolCalls: Map<string, PendingToolCall>;
}

/** chat 任务运行时（仅取消语义）。 */
interface ChatRuntime {
  controller: AbortController;
}

/** 生成临时工具回执 id（进程内唯一即可）。 */
let tempToolCallSeq = 0;
function nextToolCallId(requestId: string): string {
  tempToolCallSeq += 1;
  return `tc-${requestId}-${tempToolCallSeq}`;
}

/** 把捕获的异常归一为跨线程错误码（取消 > 超时 > 分型错误 > 未分型兜底）。 */
function toErrorCode(error: unknown, controller?: AbortController): WebAgentWorkerErrorCode {
  const reason = error instanceof Error ? error.message : String(error);
  if (reason.includes('超时')) return 'timeout';
  if (error instanceof AgentAbortError) return 'cancelled';
  if (controller?.signal.aborted) return 'cancelled';
  if (error instanceof WebAgentWorkerError) return error.code;
  return 'agent-failed';
}

/** 创建 worker 消息处理器（worker/index.ts 入口与单测共用）。 */
export function createWorkerHandle(deps: WorkerHandleDeps): {
  /** 接收一条主线程原始消息（内部先校验，非法消息记 warn 忽略）。 */
  handleMessage: (raw: unknown) => void;
} {
  const onLog = deps.onLog ?? noopLog;
  // 调用日志器：logStorage 未注入时为 no-op（record 内部吞错，落库失败不影响主流程）
  const callLogger: CallLogger = createCallLogger(deps.logStorage);
  /** 记录一条调用日志（记录请求/响应实际内容，超 8000 字符截断；api-key 等鉴权数据不落日志）。 */
  function recordCallLog(
    requestId: string,
    phase: CallLogPhase,
    payload: Record<string, unknown>,
    durationMs?: number
  ): void {
    const entry: CallLogEntry = {
      requestId,
      phase,
      ts: Date.now(),
      payload,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    callLogger.record(entry);
  }
  // fetchImpl 解构为裸标识符（对齐 dify-client 注释：规避 WebIDL Illegal invocation）
  const fetchImpl = deps.fetchImpl;
  const post = deps.post;

  const difyClient: DifyClient = createDifyClient({ fetchImpl, onLog });
  /** init 后的配置（null = 未初始化，业务消息一律 invalid-state）。 */
  let config: WebAgentWorkerConfig | null = null;
  /** init 装配的 LLM 客户端（无状态，多任务共享）。 */
  let llmClient: LlmChatClient | null = null;
  /** init 装配的 Dify 工具组（全局共享，无状态 HTTP 并发安全）。 */
  let difyTools: DifyChatTool[] = [];
  /** agent 任务运行时表（key = requestId；size 即并发占用）。 */
  const agentRuntimes = new Map<string, AgentRuntime>();
  /** chat 任务运行时表（key = requestId）。 */
  const chatRuntimes = new Map<string, ChatRuntime>();

  /** init 装配：LLM 客户端 + Dify 工具组（重复 init 忽略，客户端只发一次）。 */
  function handleInit(message: Extract<MainToWorkerMessage, { kind: 'init' }>): void {
    if (config !== null) {
      onLog('warn', 'worker_reinit_ignored', {});
      return;
    }
    config = message.config;
    const llmConfig: LlmConfig | undefined = config.llm;
    if (llmConfig !== undefined) {
      llmClient = createLlmClient(llmConfig, fetchImpl, onLog);
    }
    difyTools = (config.loop?.difyTools ?? []).map((toolConfig) =>
      buildDifyChatTool(toolConfig, { client: difyClient })
    );
  }

  /** chat 直调：不占 agent 并发槽（dify 无状态，Q4 维持）。 */
  async function handleChatRequest(
    message: Extract<MainToWorkerMessage, { kind: 'chat' }>
  ): Promise<void> {
    const { requestId, format } = message;
    const input = message.input;
    // handleMessage 已保证非空（窄化不跨函数，这里显式断言）
    const activeConfig = config as WebAgentWorkerConfig;
    const runtime: ChatRuntime = { controller: new AbortController() };
    chatRuntimes.set(requestId, runtime);
    const startedAt = Date.now();
    recordCallLog(requestId, 'chat_request', {
      query: truncateContent(input.query),
      ...(Object.keys(input.inputs ?? {}).length > 0 ? { inputs: input.inputs } : {}),
    });
    try {
      // inputs 合并策略（Q2 定案）：调用级整体覆盖，否则回退配置级，再回退空
      const chatResult = await difyClient.chat(
        {
          endpoint: activeConfig.dify.endpoint,
          query: input.query,
          responseMode: activeConfig.dify.responseMode ?? 'streaming',
          user: activeConfig.dify.user,
          inputs: input.inputs ?? activeConfig.dify.inputs ?? {},
          ...(input.conversationId !== undefined
            ? { conversationId: input.conversationId }
            : activeConfig.dify.conversationId !== undefined
              ? { conversationId: activeConfig.dify.conversationId }
              : {}),
        },
        {
          signal: runtime.controller.signal,
          // api-key 只进 Authorization 头（dify-client 内组装），不落日志
          token: activeConfig.dify.apiKey,
          timeoutMs: activeConfig.timeouts?.requestMs,
          idleTimeoutMs: activeConfig.timeouts?.idleMs,
          // format='sse'：逐分片转发 chunk（结构化增量，非原始 SSE 帧）
          ...(format === 'sse'
            ? {
                onChunk: (chunk: { event: string; delta: string; conversationId?: string }) => {
                  post({
                    kind: 'chunk',
                    requestId,
                    event: chunk.event,
                    delta: chunk.delta,
                    ...(chunk.conversationId !== undefined ? { conversationId: chunk.conversationId } : {}),
                  });
                },
              }
            : {}),
        }
      );
      const durationMs = Date.now() - startedAt;
      recordCallLog(requestId, 'chat_done', {
        ...(chatResult.conversationId !== undefined ? { conversationId: chatResult.conversationId } : {}),
        answer: truncateContent(chatResult.answer),
      }, durationMs);
      post({
        kind: 'done',
        requestId,
        taskKind: 'chat',
        answer: chatResult.answer,
        ...(chatResult.conversationId !== undefined ? { conversationId: chatResult.conversationId } : {}),
        durationMs,
      });
    } catch (error) {
      const code = toErrorCode(error, runtime.controller);
      const message = error instanceof Error ? error.message : String(error);
      recordCallLog(requestId, 'chat_error', { code, message });
      post({
        kind: 'error',
        requestId,
        code,
        message,
      });
    } finally {
      chatRuntimes.delete(requestId);
    }
  }

  /** 执行一个工具调用（dify 工具 worker 内直连；临时工具经反向协议等待主线程回执）。 */
  async function executeToolForRuntime(
    runtime: AgentRuntime,
    requestId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    // tool_start 日志在执行漏斗记录（dify / 临时工具共同入口，args 已解析为对象，结构化落库）
    recordCallLog(requestId, 'tool_start', { name, args });
    const difyTool = difyTools.find((tool) => tool.tool.name === name);
    if (difyTool !== undefined) return difyTool.execute(args);

    // 已超时移除的临时工具：防御性错误文本（LLM 视野内已移除，一般不会再调用）
    if (runtime.removedTempTools.has(name)) {
      throw new Error(`临时工具 ${name} 已因执行超时被移除，请改用其它方式完成`);
    }
    const tempDef = runtime.tempTools.get(name);
    if (tempDef === undefined) {
      throw new Error(`未知工具：${name}`);
    }
    const toolCallId = nextToolCallId(requestId);
    return new Promise<unknown>((resolve, reject) => {
      // V4 定案：worker 侧 60s 计时；超时 = isError 文本回填 + warn 日志 + 本任务清单移除
      const timer = setTimeout(() => {
        if (!runtime.pendingToolCalls.has(toolCallId)) return;
        runtime.pendingToolCalls.delete(toolCallId);
        runtime.tempTools.delete(name);
        runtime.removedTempTools.add(name);
        onLog('warn', 'temp_tool_timeout', { name, toolCallId, timeoutMs: TEMP_TOOL_TIMEOUT_MS });
        reject(new Error(`临时工具 ${name} 执行超时（60s），已自动移除`));
      }, TEMP_TOOL_TIMEOUT_MS);
      runtime.pendingToolCalls.set(toolCallId, { name, timer, resolve, reject });
      post({ kind: 'tool-call', requestId, toolCallId, name, args });
    });
  }

  /** run-agent 主流程（受理后异步执行；终态统一 post done/error）。 */
  async function runAgentTask(
    message: Extract<MainToWorkerMessage, { kind: 'run-agent' }>,
    runtime: AgentRuntime,
    taskTools: readonly AgentTool[]
  ): Promise<void> {
    const { requestId } = message;
    const input: WebAgentRunAgentInput = message.input;
    const activeConfig = config as WebAgentWorkerConfig;
    const startedAt = Date.now();
    // llm_call 迭代计数（装饰器内自增，每次 complete = 一轮调用）
    let llmIteration = 0;
    // LlmChatClient 装饰器：llm_call 日志在此记录完整请求内容（messages 逐条截断 8000），协议面不变
    const loggingLlm: LlmChatClient = {
      complete: async (messages, tools, signal) => {
        llmIteration += 1;
        recordCallLog(requestId, 'llm_call', {
          iteration: llmIteration,
          messages: messages.map((msg) => ({ ...msg, content: truncateContent(msg.content) })),
          toolCount: tools.length,
        });
        return (llmClient as LlmChatClient).complete(messages, tools, signal);
      },
    };
    try {
      const result = await runAgentLoop({
        history: input.history ?? [{ role: 'user', content: input.message }],
        tools: taskTools,
        deps: {
          llm: loggingLlm,
          // 每轮 LLM 调用前取最新清单：临时工具超时移除后 LLM 后续迭代视野内消失
          listTools: (): readonly AgentTool[] => [
            ...difyTools.map((tool) => tool.tool),
            ...[...runtime.tempTools.values()],
          ],
          executeTool: (name: string, args: Record<string, unknown>) =>
            executeToolForRuntime(runtime, requestId, name, args),
        },
        options: {
          ...(activeConfig.loop?.systemPrompt !== undefined ? { systemPrompt: activeConfig.loop.systemPrompt } : {}),
          ...(activeConfig.loop?.maxIterations !== undefined
            ? { maxIterations: activeConfig.loop.maxIterations }
            : {}),
          signal: runtime.controller.signal,
          onEvent: (event) => {
            post({ kind: 'agent-event', requestId, event });
            // tool_result / tool_error 日志在事件侧记录（内容仅在事件中可得）；
            // llm_call 与 tool_start 日志分别由 llm 装饰器与工具执行漏斗记录（含完整内容）
            switch (event.type) {
              case 'tool_result':
                recordCallLog(requestId, 'tool_result', { name: event.name, result: truncateContent(event.result) });
                break;
              case 'tool_error':
                recordCallLog(requestId, 'tool_error', { name: event.name, error: event.error });
                break;
            }
          },
        },
      });
      recordCallLog(requestId, 'agent_done', {
        text: truncateContent(result.text),
        // 完整对话记录（含 assistant tool_calls 入参）；每条消息内容统一截断保护体积
        transcript: result.transcript.map((message) => ({ ...message, content: truncateContent(message.content) })),
      }, Date.now() - startedAt);
      post({ kind: 'done', requestId, taskKind: 'agent', text: result.text, transcript: result.transcript });
    } catch (error) {
      const code = toErrorCode(error, runtime.controller);
      const message = error instanceof Error ? error.message : String(error);
      recordCallLog(requestId, 'agent_error', { code, message });
      post({
        kind: 'error',
        requestId,
        code,
        message,
      });
    } finally {
      // 清理本任务挂起回执（晚到 tool-result 按 toolCallId 出表被忽略）
      for (const pending of runtime.pendingToolCalls.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('任务已结束'));
      }
      runtime.pendingToolCalls.clear();
      agentRuntimes.delete(requestId);
    }
  }

  /** run-agent 受理：llm 缺省 / 工具名冲突 / 并发满 → 立即 error；通过则占槽并启动。 */
  function handleRunAgent(message: Extract<MainToWorkerMessage, { kind: 'run-agent' }>): void {
    const { requestId, tools } = message;
    if (llmClient === null) {
      post({ kind: 'error', requestId, code: 'agent-disabled', message: '未配置 LLM（config.llm），run-agent 不可用' });
      return;
    }
    // 临时工具名与 dify 工具名空间冲突 → invalid-state
    const difyToolNames = new Set(difyTools.map((tool) => tool.tool.name));
    const conflicted = tools.find((tool) => difyToolNames.has(tool.name));
    if (conflicted !== undefined) {
      post({
        kind: 'error',
        requestId,
        code: 'invalid-state',
        message: `临时工具名与 Dify 工具冲突：${conflicted.name}`,
      });
      return;
    }
    if (agentRuntimes.size >= AGENT_MAX_CONCURRENCY) {
      post({ kind: 'error', requestId, code: 'agent-busy', message: AGENT_BUSY_MESSAGE });
      return;
    }
    const runtime: AgentRuntime = {
      controller: new AbortController(),
      tempTools: new Map(tools.map((tool) => [tool.name, tool])),
      removedTempTools: new Set(),
      pendingToolCalls: new Map(),
    };
    agentRuntimes.set(requestId, runtime);
    post({ kind: 'agent-accepted', requestId });
    recordCallLog(requestId, 'agent_accepted', {});
    void runAgentTask(message, runtime, [
      ...difyTools.map((tool) => tool.tool),
      ...[...runtime.tempTools.values()],
    ]);
  }

  /** 主线程临时工具回执：按 requestId + toolCallId 路由；晚到/跨任务回执静默忽略。 */
  function handleToolResult(message: Extract<MainToWorkerMessage, { kind: 'tool-result' }>): void {
    const runtime = agentRuntimes.get(message.requestId);
    if (runtime === undefined) return;
    const pendingCall = runtime.pendingToolCalls.get(message.toolCallId);
    if (pendingCall === undefined) return;
    runtime.pendingToolCalls.delete(message.toolCallId);
    clearTimeout(pendingCall.timer);
    pendingCall.resolve(message.content);
  }

  /** cancel：带 id 精确取消；省略 = 终止全部在途（chat + agent）。 */
  function handleCancel(requestId: string | undefined): void {
    if (requestId === undefined) {
      for (const runtime of chatRuntimes.values()) runtime.controller.abort();
      for (const runtime of agentRuntimes.values()) runtime.controller.abort();
      return;
    }
    chatRuntimes.get(requestId)?.controller.abort();
    agentRuntimes.get(requestId)?.controller.abort();
  }

  function handleMessage(raw: unknown): void {
    let message: MainToWorkerMessage;
    try {
      message = validateMainToWorkerMessage(raw);
    } catch (error) {
      onLog('warn', 'worker_message_invalid', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    switch (message.kind) {
      case 'init':
        handleInit(message);
        return;
      case 'chat':
        if (config === null) {
          post({ kind: 'error', requestId: message.requestId, code: 'invalid-state', message: 'worker 未初始化（缺少 init 消息）' });
          return;
        }
        void handleChatRequest(message);
        return;
      case 'run-agent':
        if (config === null) {
          post({ kind: 'error', requestId: message.requestId, code: 'invalid-state', message: 'worker 未初始化（缺少 init 消息）' });
          return;
        }
        handleRunAgent(message);
        return;
      case 'cancel':
        handleCancel(message.requestId);
        return;
      case 'tool-result':
        handleToolResult(message);
        return;
    }
  }

  return { handleMessage };
}
