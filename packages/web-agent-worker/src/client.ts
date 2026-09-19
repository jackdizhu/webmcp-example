// 主线程客户端：worker 创建收发、ready 前排队缓冲、requestId 路由、
// chunk/agent-event 回调分发、临时工具反向执行、Promise 终态。
// 设计文档：docs/web-agent-worker-explore.md §3.4（chat）+ §9.8（runAgent）。
import type { AgentLoopEvent, ChatMessage } from './loop/agent-loop';
import {
  validateWorkerToMainMessage,
  type MainToWorkerMessage,
  type WebAgentChatFormat,
  type WebAgentChatInput,
  type WebAgentRunAgentInput,
  type WebAgentTempToolDef,
  type WebAgentWorkerConfig,
  type WebAgentWorkerErrorCode,
  type WorkerToMainMessage,
} from './protocol';

/** 页面临时回调工具（生命周期 = 单次 runAgent 任务，完成自动失效）。 */
export interface WebAgentTempTool {
  name: string;
  description: string;
  /** JSON Schema（AgentTool.inputSchema 同构）。 */
  inputSchema: unknown;
  /** 主线程执行；抛异常 → isError 文本回填（模型自我纠正）。 */
  execute(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/** chat 调用结果。 */
export interface WebAgentChatResult {
  answer: string;
  conversationId?: string | undefined;
  durationMs: number;
}

/** runAgent 调用结果（对话最终响应数据）。 */
export interface WebAgentRunAgentResult {
  text: string;
  /** 完整对话记录（不含 system），可直接作为下轮 history。 */
  transcript: ChatMessage[];
}

/** 跨线程请求失败（携带 worker 侧错误码）。 */
export class WebAgentRequestError extends Error {
  readonly code: WebAgentWorkerErrorCode;

  constructor(code: WebAgentWorkerErrorCode, message: string) {
    super(message);
    this.name = 'WebAgentRequestError';
    this.code = code;
  }
}

/** 单次在途请求的回调注册表项。 */
interface PendingCall {
  resolve: (value: WebAgentChatResult | WebAgentRunAgentResult) => void;
  reject: (error: WebAgentRequestError) => void;
  onChunk?: ((delta: string, meta: { event: string; conversationId?: string }) => void) | undefined;
  onEvent?: ((event: AgentLoopEvent) => void) | undefined;
  onAccepted?: ((info: { requestId: string }) => void) | undefined;
  /** 本任务的临时工具注册表（按 name 查 execute；工具名冲突已在 worker 侧拒绝）。 */
  tempTools?: Map<string, WebAgentTempTool> | undefined;
}

/** WebAgentClient 公共 API。 */
export interface WebAgentClient {
  /** Dify 直调：format 缺省 'json'；'sse' 时逐分片回调 onChunk（message_replace 携全量替换语义）。 */
  chat(
    input: WebAgentChatInput,
    options?: {
      format?: WebAgentChatFormat | undefined;
      onChunk?: ((delta: string, meta: { event: string; conversationId?: string }) => void) | undefined;
    } | undefined,
  ): Promise<WebAgentChatResult>;
  /** loop-agent：对话最终响应；临时工具随调用注册，agent-event 转发过程进度。 */
  runAgent(
    input: WebAgentRunAgentInput,
    options?: {
      tools?: WebAgentTempTool[] | undefined;
      onEvent?: ((event: AgentLoopEvent) => void) | undefined;
      /** 受理回执透传（页面留存 requestId 可精确 cancel；并发满时直接 reject 不触发）。 */
      onAccepted?: ((info: { requestId: string }) => void) | undefined;
    } | undefined,
  ): Promise<WebAgentRunAgentResult>;
  /** 取消在途任务：省略 requestId = 终止全部执行中。 */
  cancel(requestId?: string | undefined): void;
  /** 终止 worker 并拒绝全部在途请求。 */
  terminate(): void;
}

/** 全局递增序号（requestId 唯一性兜底）。 */
let requestSeq = 0;

/**
 * 生成 requestId（client 进程内唯一：时间戳 + 全局序号 + 任务类型三重保证）。
 *
 * 定义：`wa-req-<毫秒时间戳>-<全局递增序号>-<agent | tool>`。
 * 举例：wa-req-1789799626069-1-agent（agent 任务）；wa-req-1789799626069-2-tool（chat 直调）。
 * 详细：序号兜底同毫秒并发唯一性（构造保证，不依赖概率）；类型段让日志/取消
 * 可直观区分 run-agent 任务与 chat 直调。
 */
function nextRequestId(kind: 'agent' | 'tool'): string {
  requestSeq += 1;
  return `wa-req-${Date.now()}-${requestSeq}-${kind}`;
}

/**
 * 创建主线程客户端。
 *
 * @param deps.worker 消费方创建（new URL 相对路径约束），依赖注入
 * @param deps.config Dify/LLM/loop 配置，init 时传入（client 自动发送）
 * @param deps.onLog 可选日志钩子（payload 不含鉴权数据）
 */
export function createWebAgentClient(deps: {
  worker: Worker;
  config: WebAgentWorkerConfig;
  onLog?: ((level: 'debug' | 'info' | 'warn' | 'error', event: string, payload?: unknown) => void) | undefined;
}): WebAgentClient {
  const worker = deps.worker;
  const onLog = deps.onLog ?? (() => {});
  /** ready 前的出站缓冲（ready 后先 flush init 再 flush 业务消息，设计 §4.1-4）。 */
  const outboundQueue: MainToWorkerMessage[] = [];
  let ready = false;
  const pending = new Map<string, PendingCall>();

  function send(message: MainToWorkerMessage): void {
    if (ready) {
      worker.postMessage(message);
    } else {
      outboundQueue.push(message);
    }
  }

  // 首条必发 init（ready 前 client 侧排队缓冲，ready 后先于业务消息 flush）
  send({ kind: 'init', config: deps.config });

  function settleDone(record: Extract<WorkerToMainMessage, { kind: 'done' }>): void {
    const call = pending.get(record.requestId);
    if (call === undefined) return; // 终态已落定/晚到消息：忽略
    pending.delete(record.requestId);
    if (record.taskKind === 'chat') {
      call.resolve({
        answer: record.answer,
        ...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
        durationMs: record.durationMs ?? 0,
      });
      return;
    }
    call.resolve({ text: record.text, transcript: record.transcript });
  }

  /** 分发临时工具调用到页面 execute；异常捕获转 isError 回填（页面只写业务逻辑）。 */
  async function dispatchToolCall(message: Extract<WorkerToMainMessage, { kind: 'tool-call' }>): Promise<void> {
    const call = pending.get(message.requestId);
    const tool = call?.tempTools?.get(message.name);
    if (tool === undefined) {
      worker.postMessage({
        kind: 'tool-result',
        requestId: message.requestId,
        toolCallId: message.toolCallId,
        content: `临时工具 ${message.name} 不存在或已失效`,
        isError: true,
      });
      return;
    }
    try {
      const result = await tool.execute(message.args);
      worker.postMessage({
        kind: 'tool-result',
        requestId: message.requestId,
        toolCallId: message.toolCallId,
        content: JSON.stringify(result) ?? 'null',
        isError: false,
      });
    } catch (error) {
      worker.postMessage({
        kind: 'tool-result',
        requestId: message.requestId,
        toolCallId: message.toolCallId,
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    }
  }

  worker.onmessage = (event: MessageEvent<unknown>): void => {
    let message: WorkerToMainMessage;
    try {
      message = validateWorkerToMainMessage(event.data);
    } catch (error) {
      onLog('warn', 'client_message_invalid', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    switch (message.kind) {
      case 'ready': {
        ready = true;
        // 先 flush init（队列首位）再 flush 业务消息，保序
        for (const queued of outboundQueue.splice(0, outboundQueue.length)) {
          worker.postMessage(queued);
        }
        return;
      }
      case 'chunk': {
        const call = pending.get(message.requestId);
        if (call?.onChunk !== undefined) {
          call.onChunk(message.delta, {
            event: message.event,
            ...(message.conversationId !== undefined ? { conversationId: message.conversationId } : {}),
          });
        }
        return;
      }
      case 'done':
        settleDone(message);
        return;
      case 'error': {
        const call = pending.get(message.requestId);
        if (call === undefined) return; // cancel 后晚到的终态：忽略
        pending.delete(message.requestId);
        call.reject(new WebAgentRequestError(message.code, message.message));
        return;
      }
      case 'agent-event': {
        const call = pending.get(message.requestId);
        call?.onEvent?.(message.event);
        return;
      }
      case 'agent-accepted': {
        const call = pending.get(message.requestId);
        call?.onAccepted?.({ requestId: message.requestId });
        return;
      }
      case 'tool-call':
        void dispatchToolCall(message);
        return;
    }
  };

  return {
    chat(input, options = {}) {
      const requestId = nextRequestId('tool');
      const format = options.format ?? 'json';
      return new Promise<WebAgentChatResult>((resolve, reject) => {
        pending.set(requestId, {
          resolve: resolve as (value: WebAgentChatResult | WebAgentRunAgentResult) => void,
          reject,
          ...(options.onChunk !== undefined ? { onChunk: options.onChunk } : {}),
        });
        send({ kind: 'chat', requestId, input, format });
      });
    },
    runAgent(input, options = {}) {
      const requestId = nextRequestId('agent');
      // 注意：worker 收到的 tools 仅为定义（WebAgentTempToolDef）；execute 留在主线程注册表
      const toolDefs: WebAgentTempToolDef[] = (options.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return new Promise<WebAgentRunAgentResult>((resolve, reject) => {
        pending.set(requestId, {
          resolve: resolve as (value: WebAgentChatResult | WebAgentRunAgentResult) => void,
          reject,
          ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
          ...(options.onAccepted !== undefined ? { onAccepted: options.onAccepted } : {}),
          ...(options.tools !== undefined
            ? { tempTools: new Map(options.tools.map((tool) => [tool.name, tool])) }
            : {}),
        });
        send({ kind: 'run-agent', requestId, input, tools: toolDefs });
      });
    },
    cancel(requestId) {
      send({ kind: 'cancel', ...(requestId !== undefined ? { requestId } : {}) });
    },
    terminate() {
      ready = false;
      worker.terminate();
      for (const [requestId, call] of [...pending.entries()]) {
        call.reject(new WebAgentRequestError('cancelled', 'worker 已终止'));
        pending.delete(requestId);
      }
    },
  };
}
