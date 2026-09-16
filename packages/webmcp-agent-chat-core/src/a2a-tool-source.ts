// A2A 工具源（共享库 webmcp-agent-chat-core，设计 §5 D3/D4/D6；2026-09-16 协议配置扩展）。
//
// 职责：把已配置的远程 agent 暴露为本地 agent 循环可调用的工具（A2A-as-Tools）——
// jsonrpc 条目：卡片摘要拼进工具 description（模型据此选择）、callTool 编排
// message/send →（非终态时）tasks/get 轮询兜底、input-required 结构化返回 + taskId 续传；
// dify 条目：无卡片，displayName/description 静态构建工具，chat-messages 阻塞调用，
// conversation_id ↔ taskId 续传。两类条目统一 MCP CallToolResult 出口
// （与内置/页面/技能工具同一形状契约）。
//
// P0 决策约束（2026-09-12，设计 §7；2026-09-16 协议扩展修订）：
// - 工具名 `<prefix><id>__send_task`，前缀随 protocol（jsonrpc = `a2a__`，dify = `a2a_dify__`）；
//   id（agentKey）稳定不变、连接信息可改 → 工具名 id 段不漂移；
// - 同一远程 agent 同时只允许一个进行中任务（串行守卫，两类协议共用）；
// - jsonrpc：input-required = isError:false 的结构化文本（taskId + 远端问题），由模型转述追问；
//   阻塞式 message/send（无 SSE/push）；send 返回非终态时按 2s × 60 次 tasks/get 兜底轮询；
// - dify：conversationId 随结果返回，模型携 taskId=conversationId 再次调用即续传同会话。
//
// 边界红线：纯逻辑，client 经参数注入，零 chrome.*、零 Vue。
import {
  isTerminalTaskState,
  messageToText,
  type A2aTask,
  type AgentCard,
} from './a2a-types';
import { A2aClientError, type A2aClient } from './a2a-client';
import { createDifyClient, DIFY_FALLBACK_USER, type DifyClient } from './dify-client';
import { a2aRefProtocol, type AgentA2aProtocol, type AgentA2aResponseMode } from './a2a-config';
import type { AgentTool } from './agent-loop';
import type { LlmLogFn } from './llm-client';

/** 工具结果（MCP CallToolResult 同构，与内置/页面/技能工具形状一致）。 */
export interface A2aToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

/** 单个远程 agent 的运行配置（宿主从全局 a2aConfig + a2aTokens 存储解析而来，2026-09-14 解耦）。
 * 2026-09-16 协议扩展：protocol 区分 jsonrpc/dify 两类条目，dify 专属字段仅 dify 分支消费。 */
export interface A2aAgentConfig {
  /** agentKey：稳定不可变（决策 3），同时是工具名组成段，仅允许 [a-zA-Z0-9_-]。 */
  id: string;
  /** Agent Card 地址（jsonrpc 必填；dify 不适用）。 */
  cardUrl?: string;
  /** 条目协议；缺省 'jsonrpc'。 */
  protocol?: AgentA2aProtocol;
  /** 每远程 agent 的凭据（jsonrpc bearer token / dify api-key；宿主持有，只透传 client，不落日志）。 */
  token?: string;
  /**
   * JSON-RPC 端点覆盖（可选，仅 jsonrpc）：message/send / tasks/get 的 POST 地址。
   * 缺省用卡片 supportedInterfaces[0].url；Dify 等实现卡片顶层 url 指向聊天页时必须覆盖。
   */
  endpointOverride?: string;
  /** Dify chat-messages 完整地址（dify 必填）。 */
  endpoint?: string;
  /** Dify 响应模式（dify 可选；缺省 'streaming'）。 */
  responseMode?: AgentA2aResponseMode;
  /** Dify 工具展示名（dify 可选；缺省用 id）。 */
  displayName?: string;
  /** Dify 工具描述（dify 可选；缺省占位文案）。 */
  description?: string;
  /** Dify Chatflow inputs 默认值（dify 可选；缺省 {}）。 */
  inputs?: Record<string, unknown>;
  /** Dify 终端用户标识（dify 可选；宿主注入每安装稳定 uuid，缺省用客户端兜底常量）。 */
  user?: string;
}

/** 阻塞式 message/send 的单请求超时（设计 §5 D8：默认 120s，可配）。 */
export const A2A_SEND_TIMEOUT_MS = 120_000;
/** 非终态兜底轮询参数（设计 §5 D6-4：间隔 2s、上限 60 次 ≈ 120s）。 */
export const A2A_POLL_INTERVAL_MS = 2_000;
export const A2A_POLL_MAX_ATTEMPTS = 60;

/** 工具名前缀（jsonrpc，命名空间隔离，决策 1；与 chrome_extension_* 同款策略）。 */
export const A2A_TOOL_PREFIX = 'a2a__';
/** 工具名前缀（dify 条目，2026-09-16 协议扩展；独立命名空间便于 UI 徽标与路由区分）。 */
export const A2A_DIFY_TOOL_PREFIX = 'a2a_dify__';
/** 单工具固定后缀。 */
export const A2A_SEND_TASK_SUFFIX = '__send_task';

/** 由 agentKey 生成工具名（前缀随协议：jsonrpc = a2a__，dify = a2a_dify__）。 */
export function buildA2aToolName(agentId: string, protocol: AgentA2aProtocol = 'jsonrpc'): string {
  const prefix = protocol === 'dify' ? A2A_DIFY_TOOL_PREFIX : A2A_TOOL_PREFIX;
  return `${prefix}${agentId}${A2A_SEND_TASK_SUFFIX}`;
}

/** 校验 agentKey：非空且仅 [a-zA-Z0-9_-]（保证工具名合法与命名空间可解析）。 */
export function validateA2aAgentId(id: string): string {
  if (id.length === 0 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`a2a agent id 非法（仅允许字母/数字/下划线/连字符）：${id}`);
  }
  return id;
}

/** 从工具名解析 agentKey（兼容 a2a__ / a2a_dify__ 两前缀）；非 send_task 命名空间返回 null。 */
export function parseA2aToolName(name: string): string | null {
  const prefix = parseA2aToolPrefix(name);
  if (prefix === null) return null;
  const id = name.slice(prefix.length, name.length - A2A_SEND_TASK_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/** 从工具名解析协议前缀；非本工具源命名空间返回 null（注意 a2a_dify__ 不会被 a2a__ 误匹配）。 */
export function parseA2aToolPrefix(name: string): string | null {
  if (!name.endsWith(A2A_SEND_TASK_SUFFIX)) return null;
  if (name.startsWith(A2A_DIFY_TOOL_PREFIX)) return A2A_DIFY_TOOL_PREFIX;
  if (name.startsWith(A2A_TOOL_PREFIX)) return A2A_TOOL_PREFIX;
  return null;
}

/** 从工具名解析条目协议（jsonrpc / dify）；非本工具源命名空间返回 null。 */
export function parseA2aToolProtocol(name: string): AgentA2aProtocol | null {
  const prefix = parseA2aToolPrefix(name);
  if (prefix === null) return null;
  return prefix === A2A_DIFY_TOOL_PREFIX ? 'dify' : 'jsonrpc';
}

/** 卡片描述占位文案（远端 description 可为空串）。 */
const CARD_DESCRIPTION_PLACEHOLDER = '（无描述）';

/**
 * 卡片 → 工具 description：拼入卡片 name/description 与 skills 摘要清单
 * （与 skill-loader 的 L1 清单同一动机：帮模型不经过额外查询就完成选型）。
 */
export function buildA2aToolDescription(card: AgentCard): string {
  const description = card.description.length > 0 ? card.description : CARD_DESCRIPTION_PLACEHOLDER;
  const lines = [`委派任务给远程智能体「${card.name}」（A2A v${card.version}）：${description}`];
  if (card.skills.length > 0) {
    lines.push('该智能体提供的技能：');
    for (const skill of card.skills) {
      lines.push(`- ${skill.name}（id: ${skill.id}）：${skill.description}`);
    }
  }
  lines.push(
    '调用后阻塞等待远端执行：完成时返回最终回复；若返回 input-required 状态，' +
      '请把其中的问题转述给用户，拿到答复后携返回的 taskId 再次调用本工具继续同一任务。'
  );
  return lines.join('\n');
}

/** 工具定义（静态生成；执行由 callTool 编排）。 */
export function buildA2aSendTaskTool(config: A2aAgentConfig, card: AgentCard): AgentTool {
  validateA2aAgentId(config.id);
  return {
    name: buildA2aToolName(config.id),
    description: buildA2aToolDescription(card),
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '发给远程智能体的任务描述（完整、自包含，远端看不到本地对话上下文）' },
        taskId: {
          type: 'string',
          description: '可选：继续已有的 input-required 任务（来自上次工具结果中的 taskId）',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  };
}

/** Dify 工具描述占位文案（配置 description 可为空）。 */
const DIFY_DESCRIPTION_PLACEHOLDER = '（无描述）';

/**
 * Dify 工具定义（2026-09-16 协议扩展）：无 Agent Card，displayName/description 静态构建。
 * description 注明 conversationId 续传语义，帮助模型决定是否延续会话上下文。
 */
export function buildA2aDifySendTaskTool(config: A2aAgentConfig): AgentTool {
  validateA2aAgentId(config.id);
  const name = config.displayName && config.displayName.length > 0 ? config.displayName : config.id;
  const description =
    config.description !== undefined && config.description.length > 0
      ? config.description
      : DIFY_DESCRIPTION_PLACEHOLDER;
  return {
    name: buildA2aToolName(config.id, 'dify'),
    description: [
      `委派任务给远程应用「${name}」（Dify REST）：${description}`,
      '调用后阻塞等待远端执行并返回完整回复；结果附带 conversationId。',
      '入参 taskId 可选：携带上次结果中的 conversationId 可在同一会话上下文中继续对话' +
        '（远端记得该会话历史）；不带则开启全新会话。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '发给远程应用的用户消息（完整、自包含）' },
        taskId: {
          type: 'string',
          description: '可选：继续已有会话（来自上次工具结果中的 conversationId）',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  };
}

// ---- 结果包装与文本化 ----

/** 成功结果包装。 */
function toOkResult(text: string): A2aToolResult {
  return { content: [{ type: 'text', text }], isError: false };
}

/** 错误结果包装（isError:true，文本承载原因）。 */
function toErrorResult(text: string): A2aToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 生成消息 id（进程内唯一即可，避免依赖全局 crypto）。 */
function nextMessageId(): string {
  return `a2a-msg-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** 终态 task → 结果文本：最终状态消息 + artifacts（设计 §5 D4 文本化规则）。 */
function taskResultText(task: A2aTask): string {
  const sections: string[] = [];
  const statusText = messageToText(task.status?.message);
  if (statusText.length > 0) sections.push(statusText);
  for (const artifact of task.artifacts ?? []) {
    const artifactText = (artifact.parts ?? [])
      .map((part) => {
        if (part.kind === 'text' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        try {
          return `[产物 ${artifact.name ?? artifact.id ?? '未命名'}] ${JSON.stringify(part) ?? 'null'}`;
        } catch {
          return `[产物 ${artifact.name ?? artifact.id ?? '未命名'}]（不可序列化）`;
        }
      })
      .filter((text) => text.length > 0)
      .join('\n');
    if (artifactText.length > 0) sections.push(artifactText);
  }
  return sections.join('\n\n');
}

// ---- callTool 编排（校验 / 委派 / 轮询 / 状态文本化各归其位）----

/** callTool 入参校验结果（kind 区分：合法入参 / 错误结果）。 */
type ValidatedSendTaskArgs =
  | { kind: 'valid'; message: string; taskId?: string }
  | { kind: 'invalid'; error: A2aToolResult };

/** 入参校验：message 必填非空、taskId 可选非空；失败回填错误让模型自我纠正（对齐 agent-loop 语义）。 */
function validateSendTaskArgs(args: Record<string, unknown>): ValidatedSendTaskArgs {
  const message = args['message'];
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { kind: 'invalid', error: toErrorResult('入参缺少有效的 message（非空字符串）') };
  }
  const rawTaskId = args['taskId'];
  if (rawTaskId !== undefined && (typeof rawTaskId !== 'string' || rawTaskId.trim().length === 0)) {
    return { kind: 'invalid', error: toErrorResult('入参 taskId 必须是非空字符串（来自上次工具结果）') };
  }
  const taskId = typeof rawTaskId === 'string' ? rawTaskId.trim() : undefined;
  return {
    kind: 'valid',
    message,
    // exactOptionalPropertyTypes：仅在存在时携带 taskId，避免显式赋 undefined
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

/** 轮询结果：settled（终态或 input-required）task + 已尝试次数（耗尽提示用）。 */
interface PollOutcome {
  task: A2aTask;
  attempts: number;
}

/**
 * 非终态兜底轮询（tasks/get，间隔 A2A_POLL_INTERVAL_MS × 上限）。
 * 仅对 working/submitted 轮询；input-required 立即返回（决策 2：模型转述追问，
 * 用户答复后携 taskId 续传，远端任务挂起等待输入，轮询无意义）。
 */
async function pollUntilSettled(
  client: A2aClient,
  endpoint: string,
  initialTask: A2aTask,
  options: { token?: string; timeoutMs: number },
  wait: (ms: number) => Promise<void>
): Promise<PollOutcome> {
  let task = initialTask;
  let attempts = 0;
  let state = task.status.state;
  while (!isTerminalTaskState(state) && state !== 'input-required' && attempts < A2A_POLL_MAX_ATTEMPTS) {
    attempts += 1;
    await wait(A2A_POLL_INTERVAL_MS);
    task = await client.getTask(endpoint, task.id, options);
    state = task.status.state;
  }
  return { task, attempts };
}

/** 委派上下文（agentId 供日志定位；sendTimeoutMs 为阻塞 send 的单请求超时）。 */
interface DelegationContext {
  agentId: string;
  onLog: LlmLogFn;
  sendTimeoutMs: number;
}

/** settled task → 统一结果：按状态文本化（完成 / 失败取消 / input-required / 轮询耗尽）。 */
function taskStateToResult(task: A2aTask, attempts: number, context: DelegationContext): A2aToolResult {
  const state = task.status.state;
  if (state === 'completed') {
    const text = taskResultText(task);
    context.onLog('info', 'a2a_task_completed', { agentId: context.agentId, taskId: task.id });
    return toOkResult(text.length > 0 ? text : `（任务 ${task.id} 已完成，但无文本内容）`);
  }
  if (state === 'failed' || state === 'canceled') {
    const statusText = messageToText(task.status?.message);
    return toErrorResult(
      `任务${state === 'failed' ? '失败' : '已取消'}（taskId: ${task.id}）${statusText.length > 0 ? `：${statusText}` : ''}`
    );
  }
  if (state === 'input-required') {
    const question = messageToText(task.status?.message);
    return toOkResult(
      [
        '远端智能体需要补充信息才能继续（state: input-required）。',
        `taskId: ${task.id}`,
        question.length > 0 ? `问题：\n${question}` : '问题：（远端未附带具体问题文本）',
        '请把上述问题转述给用户；拿到答复后携该 taskId 再次调用本工具继续同一任务。',
      ].join('\n')
    );
  }
  // 轮询耗尽仍未终态（working/submitted）
  context.onLog('warn', 'a2a_task_poll_exhausted', { agentId: context.agentId, taskId: task.id, state });
  return toErrorResult(
    `任务长时间未完成（taskId: ${task.id}，当前状态 ${state}，已等待约 ${Math.round(
      (A2A_POLL_INTERVAL_MS * attempts) / 1000
    )}s）。请稍后缩小任务范围重试。`
  );
}

/** 被委派条目（调用方可用的最小依赖切片；dify 条目无卡片，card 为 null）。 */
type DelegationEntry = { config: A2aAgentConfig; card: AgentCard | null };

/**
 * 委派执行：jsonrpc = 阻塞 send → 直达消息文本化 → 非终态兜底轮询 → 状态文本化；
 * dify = chat-messages 单次调用（双格式解析与流式累积在 dify-client 内）。
 * 网络错误向上抛给 callTool 统一分型；本函数只负责快乐路径编排。
 */
async function delegateSendTask(
  clients: { jsonrpc: A2aClient; dify: DifyClient },
  entry: DelegationEntry,
  args: { message: string; taskId?: string },
  context: DelegationContext,
  wait: (ms: number) => Promise<void>
): Promise<A2aToolResult> {
  const config = entry.config;
  if (a2aRefProtocol(config) === 'dify') {
    // ---- dify 分支（2026-09-16 协议扩展）：conversationId ↔ taskId 续传 ----
    const result = await clients.dify.chat(
      {
        endpoint: config.endpoint ?? '',
        query: args.message,
        responseMode: config.responseMode ?? 'streaming',
        user: config.user ?? DIFY_FALLBACK_USER,
        inputs: config.inputs ?? {},
        ...(args.taskId !== undefined ? { conversationId: args.taskId } : {}),
      },
      { ...(config.token !== undefined ? { token: config.token } : {}), timeoutMs: context.sendTimeoutMs }
    );
    context.onLog('info', 'a2a_task_completed', {
      agentId: context.agentId,
      ...(result.conversationId !== undefined ? { conversationId: result.conversationId } : {}),
    });
    if (result.answer.trim().length === 0) {
      return toOkResult('（远程应用返回了空回复）');
    }
    const lines = [result.answer];
    if (result.conversationId !== undefined) {
      lines.push(
        '',
        `conversationId: ${result.conversationId}`,
        '如需在该会话基础上继续追问，请携上述 conversationId 作为 taskId 再次调用本工具（远端记得该会话历史）。'
      );
    }
    return toOkResult(lines.join('\n'));
  }

  // ---- jsonrpc 分支（现状编排）----
  // JSON-RPC 端点：显式覆盖优先（Dify 等实现卡片 url 指向聊天页），否则用卡片接口地址
  const endpoint = entry.config.endpointOverride ?? entry.card!.supportedInterfaces[0]!.url;
  const requestOptions = {
    // exactOptionalPropertyTypes：token 缺省时省略该键
    ...(entry.config.token !== undefined ? { token: entry.config.token } : {}),
    timeoutMs: context.sendTimeoutMs,
  };
  const sendResult = await clients.jsonrpc.sendMessage(
    endpoint,
    {
      role: 'user',
      parts: [{ kind: 'text', text: args.message }],
      messageId: nextMessageId(),
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    },
    requestOptions
  );

  // 直达消息响应（远端不建任务，直接回答）：文本化即结果
  if (!sendResult.task) {
    const text = messageToText(sendResult.message);
    return toOkResult(text.length > 0 ? text : '（远端返回空消息）');
  }

  const { task, attempts } = await pollUntilSettled(clients.jsonrpc, endpoint, sendResult.task, requestOptions, wait);
  return taskStateToResult(task, attempts, context);
}

export interface A2aToolSourceDeps {
  /** A2A 客户端（宿主构造并注入；测试注入带桩 client 的源）。 */
  client: A2aClient;
  /** Dify 客户端（可选；缺省用 deps.fetchImpl 构造默认客户端）。 */
  difyClient?: DifyClient;
  /** fetch 实现（构造默认 Dify 客户端用；默认全局 fetch，测试注入桩）。 */
  fetchImpl?: typeof fetch;
  /** 阻塞 send 超时毫秒（缺省 A2A_SEND_TIMEOUT_MS；Dify 请求总超时同源）。 */
  sendTimeoutMs?: number;
  /** 日志钩子（默认 no-op）。 */
  onLog?: LlmLogFn;
}

export interface A2aToolSource {
  /**
   * 更新远程 agent 集合并预取卡片（工具清单的数据源）。
   * 任一卡片抓取失败不阻断其余 agent（失败者不进清单，错误经 onLog 记录）；
   * 全部失败时 listTools 返回空清单（部分离线不阻断可用性，对齐 panel-client 语义）。
   * 返回抓取失败的 agentKey 列表（宿主可提示）。
   */
  setAgents(configs: A2aAgentConfig[]): Promise<string[]>;
  /** 当前可用工具清单（未 setAgents 或全部失败时为空）。 */
  listTools(): AgentTool[];
  /** 执行 a2a__ 命名空间工具；返回统一 CallToolResult 形状。 */
  callTool(name: string, args: Record<string, unknown>): Promise<A2aToolResult>;
  /** 释放（清缓存；进行中任务的兜底轮询自然结束于终态或轮询上限）。 */
  clear(): void;
}

/**
 * 创建 A2A 工具源。
 *
 * 单任务串行守卫（决策 5）：同一 agentKey 存在进行中任务时再次调用直接 isError。
 * 注意：agent-loop 本身逐个 await 工具（天然串行），该守卫防的是调试页与对话
 * 并发调用同一远程 agent 的场景。
 */
export function createA2aToolSource(deps: A2aToolSourceDeps): A2aToolSource {
  const onLog = deps.onLog ?? (() => {});
  const sendTimeoutMs = deps.sendTimeoutMs ?? A2A_SEND_TIMEOUT_MS;
  const difyClient = deps.difyClient ?? createDifyClient({ fetchImpl: deps.fetchImpl ?? fetch, onLog });
  /** agentKey → 运行配置。 */
  const configs = new Map<string, A2aAgentConfig>();
  /** agentKey → 卡片（dify 为 null）与工具定义（setAgents 成功后填充）。 */
  const entries = new Map<string, { config: A2aAgentConfig; card: AgentCard | null; tool: AgentTool }>();
  /** 串行守卫：进行中任务的 agentKey 集合。 */
  const inFlight = new Set<string>();

  /** 等待 poll 间隔（可被测试的假定时器推进）。 */
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    async setAgents(nextConfigs) {
      configs.clear();
      entries.clear();
      const failures: string[] = [];
      for (const raw of nextConfigs) {
        let config: A2aAgentConfig;
        try {
          config = { ...raw, id: validateA2aAgentId(raw.id) };
        } catch {
          failures.push(raw.id);
          continue;
        }
        configs.set(config.id, config);
        if (a2aRefProtocol(config) === 'dify') {
          // dify 条目：无卡片发现，静态构建工具（endpoint 缺失等在 callTool 期报错，不阻断清单）
          entries.set(config.id, { config, card: null, tool: buildA2aDifySendTaskTool(config) });
          continue;
        }
        // jsonrpc 条目：cardUrl 缺失视为配置不完整（防御式，正常由存储校验拦截）
        if (config.cardUrl === undefined || config.cardUrl.length === 0) {
          failures.push(config.id);
          onLog('warn', 'a2a_card_fetch_failed', { agentId: config.id, message: '缺少 cardUrl' });
          continue;
        }
        try {
          const card = await deps.client.fetchAgentCard(config.cardUrl, { token: config.token });
          entries.set(config.id, { config, card, tool: buildA2aSendTaskTool(config, card) });
        } catch (error) {
          failures.push(config.id);
          onLog('warn', 'a2a_card_fetch_failed', {
            agentId: config.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return failures;
    },

    listTools() {
      return [...entries.values()].map((entry) => entry.tool);
    },

    async callTool(name, args) {
      const agentId = parseA2aToolName(name);
      if (agentId === null) {
        return toErrorResult(`未知 A2A 工具：${name}`);
      }
      const entry = entries.get(agentId);
      if (!entry) {
        return toErrorResult(`远程智能体不可用（未配置或卡片抓取失败）：${agentId}`);
      }
      // 工具名前缀与条目协议一致性防御（前缀错配 = 配置变更后残留的旧工具名）
      const toolProtocol = parseA2aToolProtocol(name);
      if (toolProtocol !== null && toolProtocol !== a2aRefProtocol(entry.config)) {
        return toErrorResult(`工具 ${name} 的协议前缀与当前配置不符，请重新保存 A2A 配置后重试`);
      }

      const validated = validateSendTaskArgs(args);
      if (validated.kind === 'invalid') {
        return validated.error;
      }
      if (inFlight.has(agentId)) {
        return toErrorResult(`远程智能体 ${agentId} 已有进行中的任务，请等待其完成后再委派（P0 串行约束）`);
      }
      inFlight.add(agentId);
      try {
        return await delegateSendTask(
          { jsonrpc: deps.client, dify: difyClient },
          entry,
          validated,
          { agentId, onLog, sendTimeoutMs },
          wait
        );
      } catch (error) {
        if (error instanceof A2aClientError) {
          onLog('warn', 'a2a_call_failed', { agentId, kind: error.kind, message: error.message });
          return toErrorResult(`A2A 调用失败（${error.kind}）：${error.message}`);
        }
        const message = error instanceof Error ? error.message : String(error);
        onLog('error', 'a2a_call_unexpected', { agentId, message });
        return toErrorResult(`A2A 调用异常：${message}`);
      } finally {
        inFlight.delete(agentId);
      }
    },

    clear() {
      configs.clear();
      entries.clear();
    },
  };
}
