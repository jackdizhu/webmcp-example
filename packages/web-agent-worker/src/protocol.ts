// Worker 消息协议：主线程 ↔ worker 的双向消息类型 + 运行时校验（双向消息不可信）。
// 设计文档：docs/web-agent-worker-explore.md §3.2（v1 chat 基线）+ §9.4（v2 run-agent 扩展）。
//
// 结构化克隆承载，全 JSON-able；所有跨线程进入的消息必须先经本模块校验再消费。
import type { AgentLoopEvent, ChatMessage } from './loop/agent-loop';
import type { LlmConfig } from './loop/llm-client';

// ---- 错误分型 ----

/**
 * 跨线程错误码（error 消息与 client 侧异常共用）：
 * - invalid-url / network / http / invalid-response：对齐 dify-client 错误五分型（timeout 单列）；
 * - timeout：请求总超时 / 流空闲超时；
 * - cancelled：主线程 cancel 或 worker terminate；
 * - invalid-state：worker 未初始化收到业务消息 / 工具名冲突等状态错误；
 * - agent-busy：agent 并发槽满（上限 3，无等待队列）；
 * - agent-disabled：未配置 config.llm，run-agent 不可用；
 * - agent-failed：loop 执行中的未分型异常（LLM 客户端抛出的普通 Error 等）。
 */
export type WebAgentWorkerErrorCode =
  | 'invalid-url'
  | 'network'
  | 'http'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'invalid-state'
  | 'agent-busy'
  | 'agent-disabled'
  | 'agent-failed';

/** Worker 库错误：code 固定字段 + 人类可读 message（对齐 chat-core A2aClientError 形态）。 */
export class WebAgentWorkerError extends Error {
  readonly code: WebAgentWorkerErrorCode;

  constructor(code: WebAgentWorkerErrorCode, message: string) {
    super(message);
    this.name = 'WebAgentWorkerError';
    this.code = code;
  }
}

// ---- 配置 schema（消费方初始化时传入，设计 §3.3 + §9.7）----

/** Dify 直调配置（chat 能力必填）。 */
export interface WebAgentDifyConfig {
  /** chat-messages 完整地址（HTTP(S) 校验）。 */
  endpoint: string;
  /** api-key，仅进 Authorization 头，不落日志/持久化。 */
  apiKey: string;
  /** Dify 契约终端用户标识。 */
  user: string;
  /** Chatflow inputs 默认值；调用级 input.inputs 整体覆盖（Q2 定案）。 */
  inputs?: Record<string, unknown> | undefined;
  /** 只决定 Dify 请求体；解析按远端 Content-Type 自适应。缺省 streaming。 */
  responseMode?: 'streaming' | 'blocking' | undefined;
  /** 可选默认续传会话 ID；调用级 input.conversationId 覆盖。 */
  conversationId?: string | undefined;
}

/** 超时配置（缺省对齐 DIFY_REQUEST_TIMEOUT_MS / DIFY_STREAM_IDLE_TIMEOUT_MS）。 */
export interface WebAgentTimeoutsConfig {
  /** 请求总超时毫秒数。 */
  requestMs?: number | undefined;
  /** streaming 事件空闲超时毫秒数。 */
  idleMs?: number | undefined;
}

/** loop-agent 配置（可选；缺省 run-agent 不可用）。 */
export interface WebAgentLoopConfig {
  /** 系统提示词；缺省用内置 DEFAULT_SYSTEM_PROMPT。 */
  systemPrompt?: string | undefined;
  /** 工具调用迭代上限，缺省 8。 */
  maxIterations?: number | undefined;
  /** init 配置级预注册的 Dify 工具（worker 内直连执行；V3 定案：run-agent 不动态追加）。 */
  difyTools?: WebAgentDifyToolConfig[] | undefined;
}

/** Worker 库总配置（init 消息携带；llm/loop 缺省时 run-agent 返回 agent-disabled）。 */
export interface WebAgentWorkerConfig {
  dify: WebAgentDifyConfig;
  llm?: LlmConfig | undefined;
  loop?: WebAgentLoopConfig | undefined;
  timeouts?: WebAgentTimeoutsConfig | undefined;
}

/** Dify-as-Tool 条目配置（设计 §9.6/§9.7；工具名 dify__<id>__chat）。 */
export interface WebAgentDifyToolConfig {
  /** 工具命名空间 id，限 [a-zA-Z0-9_-]。 */
  id: string;
  /** 展示名（工具描述内引用；缺省用 id）。 */
  displayName?: string | undefined;
  /** 工具描述（模型选型依据；缺省占位文案）。 */
  description?: string | undefined;
  endpoint: string;
  apiKey: string;
  user: string;
  inputs?: Record<string, unknown> | undefined;
  responseMode?: 'streaming' | 'blocking' | undefined;
}

// ---- 消息负载类型 ----

/** chat 输出形态：'sse' = 增量分片流（结构化 chunk），'json' = 聚合一次 done。 */
export type WebAgentChatFormat = 'sse' | 'json';

/** chat 调用输入。 */
export interface WebAgentChatInput {
  query: string;
  inputs?: Record<string, unknown> | undefined;
  conversationId?: string | undefined;
}

/** run-agent 调用输入（history 可选续传，不含 system 消息）。 */
export interface WebAgentRunAgentInput {
  message: string;
  history?: ChatMessage[] | undefined;
}

/** 页面临时回调工具定义（仅定义跨线程传递；execute 留在主线程，设计 §9.5）。 */
export interface WebAgentTempToolDef {
  /** 与 dify 工具名空间不可冲突。 */
  name: string;
  /** 模型选型依据。 */
  description: string;
  /** JSON Schema（AgentTool.inputSchema 同构）。 */
  inputSchema: unknown;
}

/** 主线程 → worker 消息。 */
export type MainToWorkerMessage =
  | { kind: 'init'; config: WebAgentWorkerConfig }
  | { kind: 'chat'; requestId: string; input: WebAgentChatInput; format: WebAgentChatFormat }
  | { kind: 'run-agent'; requestId: string; input: WebAgentRunAgentInput; tools: WebAgentTempToolDef[] }
  | { kind: 'cancel'; requestId?: string | undefined }
  | { kind: 'tool-result'; requestId: string; toolCallId: string; content: string; isError?: boolean | undefined };

/** chat 增量分片（仅 format='sse'；event ∈ message / agent_message / message_replace）。 */
export interface WebAgentChunkMessage {
  kind: 'chunk';
  requestId: string;
  event: string;
  delta: string;
  conversationId?: string | undefined;
}

/** chat 终态：聚合结果。 */
export interface WebAgentChatDoneMessage {
  kind: 'done';
  requestId: string;
  /** 终态类别：chat = Dify 直调。 */
  taskKind: 'chat';
  answer: string;
  conversationId?: string | undefined;
  durationMs?: number | undefined;
}

/** agent 终态：对话最终响应（含完整记录，可作下轮 history）。 */
export interface WebAgentAgentDoneMessage {
  kind: 'done';
  requestId: string;
  /** 终态类别：agent = loop 循环。 */
  taskKind: 'agent';
  text: string;
  transcript: ChatMessage[];
}

/** worker → 主线程消息。 */
export type WorkerToMainMessage =
  | { kind: 'ready' }
  | WebAgentChunkMessage
  | WebAgentChatDoneMessage
  | WebAgentAgentDoneMessage
  | { kind: 'error'; requestId: string; code: WebAgentWorkerErrorCode; message: string }
  | { kind: 'agent-event'; requestId: string; event: AgentLoopEvent }
  | { kind: 'tool-call'; requestId: string; toolCallId: string; name: string; args: Record<string, unknown> }
  | { kind: 'agent-accepted'; requestId: string };

// ---- 运行时校验（消息不可信，先校验再消费）----

/** 校验失败统一抛错（调用方决定忽略/上报）。 */
class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${what} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new ProtocolError(`${what}.${key} 必须是字符串`);
  return value;
}

/** 必填非空字符串（endpoint / apiKey / user 等契约字段，空串直接拒绝）。 */
function requireNonEmptyString(record: Record<string, unknown>, key: string, what: string): string {
  const value = requireString(record, key, what);
  if (value.length === 0) throw new ProtocolError(`${what}.${key} 不能为空`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, what: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ProtocolError(`${what}.${key} 必须是字符串或缺省`);
  return value;
}

/** 校验 init 消息配置（浅层结构校验；深度字段由消费方各自负责）。 */
function validateConfig(value: unknown, what: string): WebAgentWorkerConfig {
  const record = requireObject(value, what);
  const difyRecord = requireObject(record['dify'], `${what}.dify`);
  const config: WebAgentWorkerConfig = {
    dify: {
      endpoint: requireNonEmptyString(difyRecord, 'endpoint', `${what}.dify`),
      apiKey: requireNonEmptyString(difyRecord, 'apiKey', `${what}.dify`),
      user: requireNonEmptyString(difyRecord, 'user', `${what}.dify`),
    },
  };
  const responseMode = optionalString(difyRecord, 'responseMode', `${what}.dify`);
  if (responseMode !== undefined) {
    if (responseMode !== 'streaming' && responseMode !== 'blocking') {
      throw new ProtocolError(`${what}.dify.responseMode 必须是 'streaming' | 'blocking'`);
    }
    config.dify.responseMode = responseMode;
  }
  const conversationId = optionalString(difyRecord, 'conversationId', `${what}.dify`);
  if (conversationId !== undefined) config.dify.conversationId = conversationId;
  if (difyRecord['inputs'] !== undefined) {
    config.dify.inputs = requireObject(difyRecord['inputs'], `${what}.dify.inputs`) as Record<string, unknown>;
  }
  if (record['llm'] !== undefined) {
    const llmRecord = requireObject(record['llm'], `${what}.llm`);
    const apiPath = optionalString(llmRecord, 'apiPath', `${what}.llm`);
    const apiProtocol = optionalString(llmRecord, 'apiProtocol', `${what}.llm`);
    config.llm = {
      apiKey: requireNonEmptyString(llmRecord, 'apiKey', `${what}.llm`),
      baseUrl: requireNonEmptyString(llmRecord, 'baseUrl', `${what}.llm`),
      model: requireNonEmptyString(llmRecord, 'model', `${what}.llm`),
      ...(apiPath !== undefined ? { apiPath } : {}),
      ...(apiProtocol !== undefined ? { apiProtocol: apiProtocol as 'openai-compat' | 'anthropic' } : {}),
      ...(typeof llmRecord['maxTokens'] === 'number' ? { maxTokens: llmRecord['maxTokens'] } : {}),
    };
  }
  if (record['loop'] !== undefined) {
    const loopRecord = requireObject(record['loop'], `${what}.loop`);
    const loop: WebAgentLoopConfig = {};
    const systemPrompt = optionalString(loopRecord, 'systemPrompt', `${what}.loop`);
    if (systemPrompt !== undefined) loop.systemPrompt = systemPrompt;
    if (loopRecord['maxIterations'] !== undefined) {
      if (typeof loopRecord['maxIterations'] !== 'number') {
        throw new ProtocolError(`${what}.loop.maxIterations 必须是数字`);
      }
      loop.maxIterations = loopRecord['maxIterations'];
    }
    if (loopRecord['difyTools'] !== undefined) {
      const difyTools = loopRecord['difyTools'];
      if (!Array.isArray(difyTools)) throw new ProtocolError(`${what}.loop.difyTools 必须是数组`);
      loop.difyTools = difyTools.map((tool) => {
        const toolRecord = requireObject(tool, `${what}.loop.difyTools[]`);
        const displayName = optionalString(toolRecord, 'displayName', `${what}.loop.difyTools[]`);
        const description = optionalString(toolRecord, 'description', `${what}.loop.difyTools[]`);
        return {
          id: requireNonEmptyString(toolRecord, 'id', `${what}.loop.difyTools[]`),
          endpoint: requireNonEmptyString(toolRecord, 'endpoint', `${what}.loop.difyTools[]`),
          apiKey: requireNonEmptyString(toolRecord, 'apiKey', `${what}.loop.difyTools[]`),
          user: requireNonEmptyString(toolRecord, 'user', `${what}.loop.difyTools[]`),
          ...(displayName !== undefined ? { displayName } : {}),
          ...(description !== undefined ? { description } : {}),
        };
      });
    }
    config.loop = loop;
  }
  if (record['timeouts'] !== undefined) {
    const timeoutsRecord = requireObject(record['timeouts'], `${what}.timeouts`);
    const timeouts: WebAgentTimeoutsConfig = {};
    if (timeoutsRecord['requestMs'] !== undefined) {
      if (typeof timeoutsRecord['requestMs'] !== 'number') {
        throw new ProtocolError(`${what}.timeouts.requestMs 必须是数字`);
      }
      timeouts.requestMs = timeoutsRecord['requestMs'];
    }
    if (timeoutsRecord['idleMs'] !== undefined) {
      if (typeof timeoutsRecord['idleMs'] !== 'number') {
        throw new ProtocolError(`${what}.timeouts.idleMs 必须是数字`);
      }
      timeouts.idleMs = timeoutsRecord['idleMs'];
    }
    config.timeouts = timeouts;
  }
  return config;
}

/** 校验主线程 → worker 消息；失败抛 ProtocolError。 */
export function validateMainToWorkerMessage(value: unknown): MainToWorkerMessage {
  const record = requireObject(value, '消息');
  const kind = requireString(record, 'kind', '消息');
  switch (kind) {
    case 'init':
      return { kind: 'init', config: validateConfig(record['config'], 'init.config') };
    case 'chat': {
      const input = requireObject(record['input'], 'chat.input');
      const format = requireString(record, 'format', 'chat');
      if (format !== 'sse' && format !== 'json') {
        throw new ProtocolError("chat.format 必须是 'sse' | 'json'");
      }
      const chatInput: WebAgentChatInput = { query: requireString(input, 'query', 'chat.input') };
      const conversationId = optionalString(input, 'conversationId', 'chat.input');
      if (conversationId !== undefined) chatInput.conversationId = conversationId;
      if (input['inputs'] !== undefined) {
        chatInput.inputs = requireObject(input['inputs'], 'chat.input.inputs') as Record<string, unknown>;
      }
      return { kind: 'chat', requestId: requireString(record, 'requestId', 'chat'), input: chatInput, format };
    }
    case 'run-agent': {
      const input = requireObject(record['input'], 'run-agent.input');
      const runInput: WebAgentRunAgentInput = { message: requireString(input, 'message', 'run-agent.input') };
      if (record['tools'] !== undefined) {
        const tools = record['tools'];
        if (!Array.isArray(tools)) throw new ProtocolError('run-agent.tools 必须是数组');
        return {
          kind: 'run-agent',
          requestId: requireString(record, 'requestId', 'run-agent'),
          input: runInput,
          tools: tools.map((tool) => validateTempToolDef(tool)),
        };
      }
      return { kind: 'run-agent', requestId: requireString(record, 'requestId', 'run-agent'), input: runInput, tools: [] };
    }
    case 'cancel': {
      const requestId = optionalString(record, 'requestId', 'cancel');
      return { kind: 'cancel', ...(requestId !== undefined ? { requestId } : {}) };
    }
    case 'tool-result': {
      const isError = record['isError'];
      if (isError !== undefined && typeof isError !== 'boolean') {
        throw new ProtocolError('tool-result.isError 必须是布尔值或缺省');
      }
      return {
        kind: 'tool-result',
        requestId: requireString(record, 'requestId', 'tool-result'),
        toolCallId: requireString(record, 'toolCallId', 'tool-result'),
        content: requireString(record, 'content', 'tool-result'),
        ...(isError === true ? { isError: true } : {}),
      };
    }
    default:
      throw new ProtocolError(`未知的消息 kind：${kind}`);
  }
}

/** 校验临时工具定义。 */
export function validateTempToolDef(value: unknown): WebAgentTempToolDef {
  const record = requireObject(value, '临时工具');
  return {
    name: requireString(record, 'name', '临时工具'),
    description: requireString(record, 'description', '临时工具'),
    inputSchema: record['inputSchema'],
  };
}

/** 校验 worker → 主线程消息；失败抛 ProtocolError。 */
export function validateWorkerToMainMessage(value: unknown): WorkerToMainMessage {
  const record = requireObject(value, '消息');
  const kind = requireString(record, 'kind', '消息');
  switch (kind) {
    case 'ready':
      return { kind: 'ready' };
    case 'chunk': {
      const chunk: WebAgentChunkMessage = {
        kind: 'chunk',
        requestId: requireString(record, 'requestId', 'chunk'),
        event: requireString(record, 'event', 'chunk'),
        delta: requireString(record, 'delta', 'chunk'),
      };
      const conversationId = optionalString(record, 'conversationId', 'chunk');
      if (conversationId !== undefined) chunk.conversationId = conversationId;
      return chunk;
    }
    case 'done': {
      const requestId = requireString(record, 'requestId', 'done');
      const taskKind = requireString(record, 'taskKind', 'done');
      if (taskKind === 'chat') {
        const done: WebAgentChatDoneMessage = {
          kind: 'done',
          requestId,
          taskKind: 'chat',
          answer: requireString(record, 'answer', 'done'),
        };
        const conversationId = optionalString(record, 'conversationId', 'done');
        if (conversationId !== undefined) done.conversationId = conversationId;
        if (typeof record['durationMs'] === 'number') done.durationMs = record['durationMs'];
        return done;
      }
      if (taskKind === 'agent') {
        const transcript = record['transcript'];
        if (!Array.isArray(transcript)) throw new ProtocolError('done.transcript 必须是数组');
        return {
          kind: 'done',
          requestId,
          taskKind: 'agent',
          text: requireString(record, 'text', 'done'),
          transcript: transcript as ChatMessage[],
        };
      }
      throw new ProtocolError(`done.taskKind 必须是 'chat' | 'agent'，实际：${taskKind}`);
    }
    case 'error': {
      const code = requireString(record, 'code', 'error');
      if (!isWebAgentWorkerErrorCode(code)) throw new ProtocolError(`error.code 非法：${code}`);
      return {
        kind: 'error',
        requestId: requireString(record, 'requestId', 'error'),
        code,
        message: requireString(record, 'message', 'error'),
      };
    }
    case 'agent-event':
      return {
        kind: 'agent-event',
        requestId: requireString(record, 'requestId', 'agent-event'),
        event: requireObject(record['event'], 'agent-event.event') as unknown as AgentLoopEvent,
      };
    case 'tool-call': {
      return {
        kind: 'tool-call',
        requestId: requireString(record, 'requestId', 'tool-call'),
        toolCallId: requireString(record, 'toolCallId', 'tool-call'),
        name: requireString(record, 'name', 'tool-call'),
        args: requireObject(record['args'], 'tool-call.args') as Record<string, unknown>,
      };
    }
    case 'agent-accepted':
      return { kind: 'agent-accepted', requestId: requireString(record, 'requestId', 'agent-accepted') };
    default:
      throw new ProtocolError(`未知的消息 kind：${kind}`);
  }
}

/** 错误码守卫（error 消息校验用）。 */
export function isWebAgentWorkerErrorCode(value: unknown): value is WebAgentWorkerErrorCode {
  return (
    value === 'invalid-url' ||
    value === 'network' ||
    value === 'http' ||
    value === 'invalid-response' ||
    value === 'timeout' ||
    value === 'cancelled' ||
    value === 'invalid-state' ||
    value === 'agent-busy' ||
    value === 'agent-disabled' ||
    value === 'agent-failed'
  );
}
