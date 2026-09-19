// Dify REST API 客户端（自包含移植自 webmcp-agent-chat-core/src/dify-client.ts）。
//
// 职责：POST chat-messages 的组包、超时、错误分型与双响应格式解析——
// - application/json（blocking）：一次解析 answer / conversation_id；
// - text/event-stream（streaming）：fetch + ReadableStream 手工解析 SSE
//   （EventSource 不可用：仅支持 GET 且无法携带 POST body），message/agent_message
//   累积 answer，message_end 终止，error 事件失败，ping/其余事件忽略。
// **响应分派按 Content-Type 自适应**（不信任请求参数约定）：配置的 responseMode
// 只决定请求体，远端实际返回什么格式就按什么格式解析。
//
// 相对移植源的扩展：DifyRequestOptions 增加可选 onChunk —— streaming 消费过程中把每个
// 已解析校验的文本分片/整体替换事件实时回调（Worker 侧据此向主线程转发 chunk 消息）。
//
// 边界红线：transport 由消费方注入（fetchImpl），零 chrome.*、零 DOM；
// 埋点只记 URL/事件/状态/耗时，绝不记录 Authorization 头与请求体（日志红线）。
import { WebAgentWorkerError } from '../protocol';
import {
  isDifyTextChunkEvent,
  validateDifyChatResponse,
  validateDifyStreamEvent,
} from './dify-types';
import type { LlmLogFn } from '../loop/llm-client';

/** 单次 Dify 请求选项（字段允许显式 undefined，适配 exactOptionalPropertyTypes）。 */
export interface DifyRequestOptions {
  /** Dify api-key（Authorization: Bearer，消费方注入，不落日志）。 */
  token?: string | undefined;
  /** 外部终止信号。 */
  signal?: AbortSignal | undefined;
  /** 请求总超时毫秒数（blocking 与 streaming 通用；缺省 120s）。 */
  timeoutMs?: number | undefined;
  /** streaming 两次事件的空闲超时毫秒数（缺省 30s；超时判连接中断）。 */
  idleTimeoutMs?: number | undefined;
  /**
   * streaming 分片实时回调（仅 text/event-stream 响应会触发）；
   * message_replace 的 delta 为整体替换文本。payload 不含鉴权数据。
   */
  onChunk?: ((chunk: { event: string; delta: string; conversationId?: string }) => void) | undefined;
}

/** 单次对话输入。 */
export interface DifyChatInput {
  /** chat-messages 完整地址（如 https://host/v1/chat-messages）。 */
  endpoint: string;
  /** 用户消息。 */
  query: string;
  /** 响应模式（只决定请求体；解析按响应 Content-Type 自适应）。 */
  responseMode: 'streaming' | 'blocking';
  /** 终端用户标识（Dify 契约必填）。 */
  user: string;
  /** Chatflow inputs 默认值（缺省 {}）。 */
  inputs: Record<string, unknown>;
  /** 续传会话 ID（可选；缺省 = 新会话）。 */
  conversationId?: string | undefined;
}

/** 对话结果（answer 拼接完成后的最终形态）。 */
export interface DifyChatResult {
  answer: string;
  /** 会话 ID（续传用；远端未返回时缺省）。 */
  conversationId?: string;
}

export interface DifyClientDeps {
  /** fetch 实现（必填注入，无默认全局依赖，测试确定性强）。 */
  fetchImpl: typeof fetch;
  /** 日志钩子（默认 no-op；payload 不含鉴权数据）。 */
  onLog?: LlmLogFn | undefined;
}

export interface DifyClient {
  /** 发送对话消息并返回完整回复（blocking 一次解析 / streaming 流式累积，见模块头注释）。 */
  chat(input: DifyChatInput, options?: DifyRequestOptions): Promise<DifyChatResult>;
}

/** 默认请求总超时（毫秒）。 */
export const DIFY_REQUEST_TIMEOUT_MS = 120_000;
/** streaming 事件空闲超时（毫秒）：两次事件间隔超过即判连接中断。 */
export const DIFY_STREAM_IDLE_TIMEOUT_MS = 30_000;

const noopLog: LlmLogFn = () => {};

/** 把 AbortError 归一为确定性超时/终止文案。 */
function abortErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes('超时') ? reason : '请求已被终止';
}

/** 校验 URL 是 HTTP(S)；统一 invalid-url 错误。 */
function requireHttpUrl(url: string, what: string): string {
  if (!isHttpUrlValue(url)) {
    throw new WebAgentWorkerError('invalid-url', `${what} 不是合法的 HTTP(S) 地址：${url}`);
  }
  return url;
}

function isHttpUrlValue(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 组装鉴权头（token 只进 Authorization 头，不落日志与请求体）。 */
function buildAuthHeaders(options: DifyRequestOptions | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;
  return headers;
}

/** 组装超时 + 外部 signal 的联合 AbortController。 */
function createTimeoutController(
  timeoutMs: number,
  external?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** 解析 blocking JSON 响应体（answer 必填；带 message 的业务错误归一为 invalid-response）。 */
function parseBlockingPayload(payload: unknown): DifyChatResult {
  // Dify 可能以 HTTP 200 + 业务错误负载响应（防御式：有 message + code/status 无 answer 视为错误）
  const record = payload as Record<string, unknown> | null;
  if (
    record !== null &&
    typeof record === 'object' &&
    typeof record['message'] === 'string' &&
    typeof record['answer'] !== 'string' &&
    (record['code'] !== undefined || record['status'] !== undefined)
  ) {
    throw new WebAgentWorkerError('invalid-response', `Dify 业务错误：${record['message'] as string}`);
  }
  try {
    const validated = validateDifyChatResponse(payload);
    return {
      answer: validated.answer,
      ...(typeof validated.conversation_id === 'string' ? { conversationId: validated.conversation_id } : {}),
    };
  } catch (error) {
    throw new WebAgentWorkerError(
      'invalid-response',
      `blocking 响应校验失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 解析 SSE 文本块为事件 JSON 数组（Dify 格式：`data: {...}\n\n`，事件类型在 data JSON 内）。
 * 缓冲区残留（最后一段未以空行结尾）原样返回由调用方续存。
 */
function extractSseDataPayloads(buffer: string): { payloads: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const payloads: string[] = [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      // 仅取 data: 行；event:/id:/retry: 行与注释行忽略（事件类型在 data JSON 内）
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload.length > 0 && payload !== '[DONE]') payloads.push(payload);
      }
    }
  }
  return { payloads, rest };
}

/**
 * 创建 Dify REST 客户端。
 *
 * @param deps fetchImpl 必填注入（无默认全局依赖，测试确定性强）；onLog 可选
 */
export function createDifyClient(deps: DifyClientDeps): DifyClient {
  const onLog = deps.onLog ?? noopLog;
  // fetchImpl 必须解构后以裸标识符调用：原生 fetch 是 WebIDL 操作，方法调用形态
  // 会把 this 绑到 deps 对象上抛 Illegal invocation。
  const fetchImpl = deps.fetchImpl;

  return {
    async chat(input, options = {}) {
      const endpoint = requireHttpUrl(input.endpoint, 'Dify 接口地址');
      const timeoutMs = options.timeoutMs ?? DIFY_REQUEST_TIMEOUT_MS;
      const idleTimeoutMs = options.idleTimeoutMs ?? DIFY_STREAM_IDLE_TIMEOUT_MS;
      const body = JSON.stringify({
        inputs: input.inputs,
        query: input.query,
        response_mode: input.responseMode,
        user: input.user,
        ...(input.conversationId !== undefined && input.conversationId.length > 0
          ? { conversation_id: input.conversationId }
          : {}),
      });
      const startedAt = Date.now();
      const { signal, cleanup } = createTimeoutController(timeoutMs, options.signal);
      try {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: buildAuthHeaders(options),
            body,
            signal,
          });
        } catch (error) {
          if (signal.aborted) {
            throw new WebAgentWorkerError('network', abortErrorMessage(error));
          }
          throw new WebAgentWorkerError('network', `网络请求失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response.ok) {
          throw new WebAgentWorkerError('http', `Dify 接口返回 HTTP ${response.status}（chat-messages）`);
        }
        const contentType = response.headers.get('Content-Type') ?? '';
        if (contentType.includes('text/event-stream')) {
          return await consumeStreamResponse(response, { onLog, endpoint, idleTimeoutMs, startedAt, onChunk: options.onChunk });
        }
        // application/json（blocking）：一次解析
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw new WebAgentWorkerError(
            'invalid-response',
            `blocking 响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
          );
        }
        const result = parseBlockingPayload(payload);
        onLog('debug', 'dify_request', {
          url: endpoint,
          mode: 'blocking',
          status: response.status,
          durationMs: Date.now() - startedAt,
          ...(result.conversationId !== undefined ? { conversationId: result.conversationId } : {}),
        });
        return result;
      } finally {
        cleanup();
      }
    },
  };
}

/** streaming 消费上下文。 */
interface StreamContext {
  onLog: LlmLogFn;
  endpoint: string;
  idleTimeoutMs: number;
  startedAt: number;
  /** 分片实时回调（可选；调用方未传则不回调）。 */
  onChunk?: ((chunk: { event: string; delta: string; conversationId?: string }) => void) | undefined;
}

/**
 * 消费 event-stream 响应：reader 逐块解码 → SSE 分帧 → 事件分派（累积/终止/失败/忽略）。
 * 空闲超时单独计时（每收到一块重置）；总超时由外层 AbortController 统一裁剪。
 */
async function consumeStreamResponse(response: Response, context: StreamContext): Promise<DifyChatResult> {
  const { onLog, endpoint, idleTimeoutMs, startedAt, onChunk } = context;
  const body = response.body;
  if (body === null) {
    throw new WebAgentWorkerError('invalid-response', 'event-stream 响应缺少可读流');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let conversationId: string | undefined;

  /** 空闲超时控制：每收到一块重置；触发时 abort reader 抛错。 */
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => void reader.cancel(new Error(`流空闲超时（${idleTimeoutMs}ms 内无新事件）`)),
      idleTimeoutMs
    );
  };
  armIdleTimer();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      armIdleTimer();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = extractSseDataPayloads(buffer);
      buffer = rest;
      for (const payload of payloads) {
        let event: ReturnType<typeof validateDifyStreamEvent>;
        try {
          event = validateDifyStreamEvent(JSON.parse(payload));
        } catch (error) {
          throw new WebAgentWorkerError(
            'invalid-response',
            `stream 事件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (isDifyTextChunkEvent(event.event)) {
          if (typeof event.conversation_id === 'string') conversationId = event.conversation_id;
          if (typeof event.answer === 'string') {
            answer += event.answer;
            if (onChunk !== undefined) {
              onChunk({
                event: typeof event.event === 'string' ? event.event : 'message',
                delta: event.answer,
                ...(conversationId !== undefined ? { conversationId } : {}),
              });
            }
          }
          continue;
        }
        if (event.event === 'message_replace') {
          // 内容审查替换：整体替换已累积 answer（官方契约），delta 携带全量替换文本
          if (typeof event.answer === 'string') {
            answer = event.answer;
            if (onChunk !== undefined) {
              onChunk({
                event: 'message_replace',
                delta: event.answer,
                ...(conversationId !== undefined ? { conversationId } : {}),
              });
            }
          }
          continue;
        }
        if (event.event === 'message_end') {
          if (typeof event.conversation_id === 'string' && conversationId === undefined) {
            conversationId = event.conversation_id;
          }
          onLog('debug', 'dify_request', {
            url: endpoint,
            mode: 'stream',
            status: response.status,
            durationMs: Date.now() - startedAt,
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          return answer.length > 0
            ? { answer, ...(conversationId !== undefined ? { conversationId } : {}) }
            : { answer: '', ...(conversationId !== undefined ? { conversationId } : {}) };
        }
        if (event.event === 'error') {
          const detail = typeof event.message === 'string' ? event.message : '远端流内错误（无 message 字段）';
          throw new WebAgentWorkerError('invalid-response', `Dify 流内错误：${detail}`);
        }
        // ping / agent_thought / message_file / tts_* / workflow_* 等忽略
      }
    }
    // 流自然结束（无 message_end）：以已累积内容为结果（防御式，不强求终止事件）
    onLog('debug', 'dify_request', {
      url: endpoint,
      mode: 'stream-eof',
      status: response.status,
      durationMs: Date.now() - startedAt,
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    return { answer, ...(conversationId !== undefined ? { conversationId } : {}) };
  } catch (error) {
    if (error instanceof WebAgentWorkerError) throw error;
    if (signalAbortedByIdle(error)) {
      throw new WebAgentWorkerError('network', `流空闲超时（${idleTimeoutMs}ms 内无新事件）`);
    }
    throw new WebAgentWorkerError('network', `流读取失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }
}

/** 判定错误是否为 reader.cancel(流空闲超时) 触发的终止。 */
function signalAbortedByIdle(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes('空闲超时');
}
