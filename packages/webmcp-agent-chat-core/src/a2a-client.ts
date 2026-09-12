// A2A JSON-RPC 2.0 客户端（共享库 webmcp-agent-chat-core，设计 §5 D2）。
//
// 职责：Agent Card 抓取 + message/send、tasks/get、tasks/cancel 三个 JSON-RPC 方法
// 的组包、超时、错误分型与响应校验。P0 为阻塞式 send（无 SSE / push notifications，
// 见设计 §3 取舍与 §5 D6）。
//
// 边界红线：transport 由宿主注入（fetchImpl，对齐 llm-client.ts 先例），零 chrome.*；
// 埋点只记 URL/方法/状态/耗时，绝不记录 Authorization 头与请求体（日志红线同 llm-client）。
import {
  isHttpUrl,
  validateAgentCard,
  validateA2aTask,
  type A2aMessage,
  type A2aTask,
  type AgentCard,
} from './a2a-types';
import type { LlmLogFn } from './llm-client';

/** 客户端错误分型（调用方据此决定 isError 文案与是否可重试）。 */
export type A2aClientErrorKind = 'network' | 'http' | 'rpc' | 'invalid-response' | 'invalid-url';

/** A2A 客户端错误：kind 固定字段 + 人类可读 message。 */
export class A2aClientError extends Error {
  readonly kind: A2aClientErrorKind;
  /** JSON-RPC error.code（仅 rpc 型有值）。 */
  readonly rpcCode: number | undefined;

  constructor(kind: A2aClientErrorKind, message: string, rpcCode?: number) {
    super(message);
    this.name = 'A2aClientError';
    this.kind = kind;
    this.rpcCode = rpcCode;
  }
}

/** 单次 JSON-RPC 请求选项（字段允许显式 undefined，适配 exactOptionalPropertyTypes）。 */
export interface A2aRequestOptions {
  /** 每请求鉴权（宿主经 getToken 注入，客户端只放进 Authorization 头、不落日志）。 */
  token?: string | undefined;
  /** 外部终止信号（对齐 agent-loop 的 signal 语义）。 */
  signal?: AbortSignal | undefined;
  /** 请求超时毫秒数；缺省用客户端默认（30s）。 */
  timeoutMs?: number | undefined;
}

export interface A2aClientDeps {
  /** fetch 实现（默认全局 fetch，测试注入桩）。 */
  fetchImpl: typeof fetch;
  /** 日志钩子（默认 no-op；payload 不含鉴权数据）。 */
  onLog?: LlmLogFn | undefined;
}

/** message/send 的响应（spec：Task 或 Message 二选一）。 */
export interface A2aSendResult {
  task?: A2aTask;
  message?: A2aMessage;
}

export interface A2aClient {
  /** 抓取并校验 Agent Card（GET，不走 JSON-RPC）。 */
  fetchAgentCard(cardUrl: string, options?: A2aRequestOptions): Promise<AgentCard>;
  /** 发送消息委派任务（阻塞式，返回终态 task 或中间消息）。 */
  sendMessage(endpoint: string, message: A2aMessage, options?: A2aRequestOptions): Promise<A2aSendResult>;
  /** 查询任务状态（轮询兜底：send 返回非终态 task 时由上层编排续询）。 */
  getTask(endpoint: string, taskId: string, options?: A2aRequestOptions): Promise<A2aTask>;
  /** 请求取消任务（远端可能拒绝或异步生效，以 tasks/get 结果为准）。 */
  cancelTask(endpoint: string, taskId: string, options?: A2aRequestOptions): Promise<A2aTask>;
}

/** 默认单请求超时（毫秒）。 */
export const A2A_REQUEST_TIMEOUT_MS = 30_000;

const noopLog: LlmLogFn = () => {};

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

let nextRequestId = 1;

/** 生成递增请求 id（进程内唯一即可，A2A 不要求跨端复现）。 */
function takeRequestId(): number {
  const id = nextRequestId;
  nextRequestId += 1;
  return id;
}

/** 组装超时 + 外部 signal 的联合 AbortController；返回清理函数与内部 signal。 */
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

/** 把 AbortError 归一为确定性超时/终止文案。 */
function abortErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes('超时') ? reason : '请求已被终止';
}

/**
 * 创建 A2A JSON-RPC 客户端。
 *
 * @param deps fetchImpl 必填注入（无默认全局依赖，测试确定性强）；onLog 可选
 */
export function createA2aClient(deps: A2aClientDeps): A2aClient {
  const onLog = deps.onLog ?? noopLog;
  // fetchImpl 必须解构后以裸标识符调用：原生 fetch 是 WebIDL 操作，`deps.fetchImpl(...)` 方法
  // 调用形态会把 this 绑到 deps 对象上，Chrome 抛
  // "Failed to execute 'fetch' on 'Window': Illegal invocation"（裸标识符调用 this=undefined，
  // 由 WebIDL 替换为全局对象，行为与 llm-client.ts 一致）。
  const fetchImpl = deps.fetchImpl;

  /** 校验 URL 是 HTTP(S)；统一 invalid-url 错误（设计 §5 D8 安全底线）。 */
  const requireUrl = (url: string, what: string): string => {
    if (!isHttpUrl(url)) {
      throw new A2aClientError('invalid-url', `${what} 不是合法的 HTTP(S) 地址：${url}`);
    }
    return url;
  };

  /** 统一的 JSON-RPC POST：组包 → 超时控制 → 分型错误 → 响应校验。 */
  const rpcCall = async (
    endpoint: string,
    method: string,
    params: unknown,
    options?: A2aRequestOptions
  ): Promise<unknown> => {
    const url = requireUrl(endpoint, 'A2A 端点');
    const timeoutMs = options?.timeoutMs ?? A2A_REQUEST_TIMEOUT_MS;
    const { signal, cleanup } = createTimeoutController(timeoutMs, options?.signal);
    const requestId = takeRequestId();
    const startedAt = Date.now();
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new A2aClientError('network', abortErrorMessage(error));
        }
        throw new A2aClientError('network', `网络请求失败：${error instanceof Error ? error.message : String(error)}`);
      }
      onLog('debug', 'a2a_rpc', { url, method, status: response.status, durationMs: Date.now() - startedAt });
      if (!response.ok) {
        throw new A2aClientError('http', `远端返回 HTTP ${response.status}（${method}）`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new A2aClientError('invalid-response', `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
      }
      const rpc = payload as JsonRpcResponse;
      if (rpc && typeof rpc === 'object' && rpc.error !== undefined && rpc.error !== null) {
        const err = rpc.error;
        const code = typeof err.code === 'number' ? err.code : undefined;
        const message = typeof err.message === 'string' ? err.message : '远端返回未知 JSON-RPC 错误';
        throw new A2aClientError('rpc', `远端 JSON-RPC 错误（${method}）：${message}`, code);
      }
      if (!(rpc && typeof rpc === 'object' && 'result' in rpc)) {
        throw new A2aClientError('invalid-response', `响应缺少 result 字段（${method}）`);
      }
      return rpc.result;
    } finally {
      cleanup();
    }
  };

  return {
    async fetchAgentCard(cardUrl, options) {
      const url = requireUrl(cardUrl, 'Agent Card URL');
      const timeoutMs = options?.timeoutMs ?? A2A_REQUEST_TIMEOUT_MS;
      const { signal, cleanup } = createTimeoutController(timeoutMs, options?.signal);
      const startedAt = Date.now();
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;
        let response: Response;
        try {
          response = await fetchImpl(url, { method: 'GET', headers, signal });
        } catch (error) {
          if (signal.aborted) {
            throw new A2aClientError('network', abortErrorMessage(error));
          }
          throw new A2aClientError('network', `网络请求失败：${error instanceof Error ? error.message : String(error)}`);
        }
        onLog('debug', 'a2a_card', { url, status: response.status, durationMs: Date.now() - startedAt });
        if (!response.ok) {
          throw new A2aClientError('http', `Agent Card 抓取返回 HTTP ${response.status}`);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw new A2aClientError('invalid-response', `Agent Card 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          return validateAgentCard(payload);
        } catch (error) {
          throw new A2aClientError('invalid-response', error instanceof Error ? error.message : String(error));
        }
      } finally {
        cleanup();
      }
    },

    async sendMessage(endpoint, message, options) {
      const result = await rpcCall(endpoint, 'message/send', { message }, options);
      if (typeof result !== 'object' || result === null) {
        throw new A2aClientError('invalid-response', 'message/send 的 result 不是对象');
      }
      const record = result as Record<string, unknown>;
      if (record['kind'] === 'task' || record['status'] !== undefined) {
        try {
          return { task: validateA2aTask(result) };
        } catch (error) {
          throw new A2aClientError('invalid-response', error instanceof Error ? error.message : String(error));
        }
      }
      if (record['kind'] === 'message' || record['parts'] !== undefined) {
        return { message: result as A2aMessage };
      }
      throw new A2aClientError('invalid-response', 'message/send 的 result 既不是 task 也不是 message');
    },

    async getTask(endpoint, taskId, options) {
      const result = await rpcCall(endpoint, 'tasks/get', { id: taskId }, options);
      try {
        return validateA2aTask(result);
      } catch (error) {
        throw new A2aClientError('invalid-response', error instanceof Error ? error.message : String(error));
      }
    },

    async cancelTask(endpoint, taskId, options) {
      const result = await rpcCall(endpoint, 'tasks/cancel', { id: taskId }, options);
      try {
        return validateA2aTask(result);
      } catch (error) {
        throw new A2aClientError('invalid-response', error instanceof Error ? error.message : String(error));
      }
    },
  };
}
