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

// ---- 公共 HTTP 执行段（卡片抓取与 JSON-RPC 同构：超时 / 错误分型 / 日志 / JSON 解析）----

/** 单次 HTTP 请求计划（公共执行段的输入；文案差异由调用方注入）。 */
interface HttpRequestPlan {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** POST 请求体（JSON 字符串）；GET 省略。 */
  body?: string;
  /** debug 日志事件名。 */
  logEvent: string;
  /** 非 2xx 状态码的错误文案。 */
  httpErrorMessage: (status: number) => string;
  /** 响应非合法 JSON 时的错误文案前缀。 */
  jsonErrorLabel: string;
  /** 附加日志字段（调用方按原埋点形态注入，如 JSON-RPC 方法名；不注入则无附加键）。 */
  logContext?: Record<string, unknown>;
}

/** 组装鉴权头（token 只进 Authorization 头，不落日志与请求体）。 */
function buildAuthHeaders(options: A2aRequestOptions | undefined, base: Record<string, string>): Record<string, string> {
  if (options?.token) return { ...base, Authorization: `Bearer ${options.token}` };
  return base;
}

/** 把 AbortError 归一为确定性超时/终止文案。 */
function abortErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.includes('超时') ? reason : '请求已被终止';
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

/** 校验 URL 是 HTTP(S)；统一 invalid-url 错误（设计 §5 D8 安全底线）。 */
function requireHttpUrl(url: string, what: string): string {
  if (!isHttpUrl(url)) {
    throw new A2aClientError('invalid-url', `${what} 不是合法的 HTTP(S) 地址：${url}`);
  }
  return url;
}

/**
 * 公共 HTTP 执行段：超时控制 → fetch（网络错误分型）→ debug 日志 → 状态校验 → JSON 解析。
 * 卡片抓取（GET）与 JSON-RPC（POST）共用；调用方只注入差异文案。
 */
async function executeJsonRequest(
  fetchImpl: typeof fetch,
  onLog: LlmLogFn,
  plan: HttpRequestPlan,
  options: A2aRequestOptions | undefined
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? A2A_REQUEST_TIMEOUT_MS;
  const { signal, cleanup } = createTimeoutController(timeoutMs, options?.signal);
  const startedAt = Date.now();
  try {
    let response: Response;
    try {
      response = await fetchImpl(plan.url, {
        method: plan.method,
        headers: plan.headers,
        // exactOptionalPropertyTypes：仅 GET 无 body 时省略该键
        ...(plan.body !== undefined ? { body: plan.body } : {}),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new A2aClientError('network', abortErrorMessage(error));
      }
      throw new A2aClientError('network', `网络请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    onLog('debug', plan.logEvent, {
      url: plan.url,
      ...plan.logContext,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    if (!response.ok) {
      throw new A2aClientError('http', plan.httpErrorMessage(response.status));
    }
    try {
      return await response.json();
    } catch (error) {
      throw new A2aClientError(
        'invalid-response',
        `${plan.jsonErrorLabel}：${error instanceof Error ? error.message : String(error)}`
      );
    }
  } finally {
    cleanup();
  }
}

/** JSON-RPC 响应校验：error 对象分型为 rpc（保留 code），缺 result 分型为 invalid-response。 */
function validateRpcResult(payload: unknown, method: string): unknown {
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
}

/** 校验 task 型结果，校验异常统一包装为 invalid-response（三处调用点共用）。 */
function toValidatedTask(result: unknown): A2aTask {
  try {
    return validateA2aTask(result);
  } catch (error) {
    throw new A2aClientError('invalid-response', error instanceof Error ? error.message : String(error));
  }
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

  const rpcCall = async (
    endpoint: string,
    method: string,
    params: unknown,
    options?: A2aRequestOptions
  ): Promise<unknown> => {
    const url = requireHttpUrl(endpoint, 'A2A 端点');
    const payload = await executeJsonRequest(
      fetchImpl,
      onLog,
      {
        url,
        method: 'POST',
        headers: buildAuthHeaders(options, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: takeRequestId(), method, params }),
        logEvent: 'a2a_rpc',
        httpErrorMessage: (status) => `远端返回 HTTP ${status}（${method}）`,
        jsonErrorLabel: '响应不是合法 JSON',
        // 原埋点形态：a2a_rpc 的 method 键承载 JSON-RPC 方法名（非 HTTP 方法）
        logContext: { method },
      },
      options
    );
    return validateRpcResult(payload, method);
  };

  return {
    async fetchAgentCard(cardUrl, options) {
      const url = requireHttpUrl(cardUrl, 'Agent Card URL');
      const payload = await executeJsonRequest(
        fetchImpl,
        onLog,
        {
          url,
          method: 'GET',
          headers: buildAuthHeaders(options, { Accept: 'application/json' }),
          logEvent: 'a2a_card',
          httpErrorMessage: (status) => `Agent Card 抓取返回 HTTP ${status}`,
          jsonErrorLabel: 'Agent Card 不是合法 JSON',
        },
        options
      );
      try {
        return validateAgentCard(payload);
      } catch (error) {
        throw new A2aClientError('invalid-response', error instanceof Error ? error.message : String(error));
      }
    },

    async sendMessage(endpoint, message, options) {
      const result = await rpcCall(endpoint, 'message/send', { message }, options);
      if (typeof result !== 'object' || result === null) {
        throw new A2aClientError('invalid-response', 'message/send 的 result 不是对象');
      }
      const record = result as Record<string, unknown>;
      if (record['kind'] === 'task' || record['status'] !== undefined) {
        return { task: toValidatedTask(result) };
      }
      if (record['kind'] === 'message' || record['parts'] !== undefined) {
        return { message: result as A2aMessage };
      }
      throw new A2aClientError('invalid-response', 'message/send 的 result 既不是 task 也不是 message');
    },

    async getTask(endpoint, taskId, options) {
      const result = await rpcCall(endpoint, 'tasks/get', { id: taskId }, options);
      return toValidatedTask(result);
    },

    async cancelTask(endpoint, taskId, options) {
      const result = await rpcCall(endpoint, 'tasks/cancel', { id: taskId }, options);
      return toValidatedTask(result);
    },
  };
}
