// agent 循环（自包含移植自 webmcp-agent-chat-core/src/agent-loop.ts，V0-1：不跨包引用）。
//
// 职责：把用户消息 + 工具清单交给 LLM，若 LLM 返回工具调用则执行并把结果回填对话，
// 循环直到 LLM 给出最终文本回复或达到迭代上限。对话消息结构与 OpenAI 兼容的
// chat completions 工具调用协议对齐。
// 有意扩展（设计 §9.2）：AgentLoopDeps 增加可选 listTools —— 每轮 LLM 调用前取最新
// 工具清单（支撑 Worker 侧临时工具超时后从 LLM 视野内移除），缺省回退 params.tools 静态清单。

/** 透传给 LLM 的工具元数据（schema 原样保留）。 */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** 对话消息角色。 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 工具调用请求（LLM assistant 消息中的 tool_calls 项）。 */
export interface ToolCallRequest {
  id: string;
  function: {
    name: string;
    /** JSON 字符串形式的入参（协议规定），解析失败时回填错误让模型自我纠正。 */
    arguments: string;
  };
}

/** 对话消息（本库内部对话状态的统一形态）。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 仅 assistant 消息可能携带的工具调用请求。 */
  toolCalls?: ToolCallRequest[];
  /** 仅 tool 消息携带：对应的工具调用 id。 */
  toolCallId?: string;
}

/** LLM 客户端接口（由 llm-client.ts 提供两协议实现，测试可注入桩）。 */
export interface LlmChatClient {
  complete(
    messages: readonly ChatMessage[],
    tools: readonly AgentTool[],
    signal?: AbortSignal
  ): Promise<ChatMessage>;
}

/** 循环过程事件，供页面实时展示执行进度。 */
export type AgentLoopEvent =
  | { type: 'llm_call'; iteration: number }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'tool_error'; name: string; error: string };

/** 循环依赖项。 */
export interface AgentLoopDeps {
  llm: LlmChatClient;
  /**
   * 取最新工具清单（每轮 LLM 调用前调用；缺省回退 params.tools 静态清单）。
   * Worker 侧临时工具超时移除后经此让 LLM 后续迭代不再看到该工具。
   */
  listTools?: () => readonly AgentTool[];
  /** 执行单个工具；抛异常视为执行失败（错误内容会文本化回填给模型）。 */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** 循环被终止时抛出（Worker 侧据此转为 error(cancelled) 终态）。 */
export class AgentAbortError extends Error {
  constructor() {
    super('本轮对话已被终止');
    this.name = 'AgentAbortError';
  }
}

/** 循环选项。 */
export interface AgentLoopOptions {
  /** 系统提示词，缺省使用内置提示。 */
  systemPrompt?: string;
  /** 工具调用迭代上限，防止模型无限循环，默认 8。 */
  maxIterations?: number;
  /** 过程事件回调。 */
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * 终止信号：每次 LLM 调用与工具执行前检查，已中止则抛 AgentAbortError
   * 并停止后续迭代（正在执行的工具调用无法真正中断，等待其完成后停止）。
   */
  signal?: AbortSignal;
}

export const DEFAULT_SYSTEM_PROMPT =
  '你是后台智能体助手。用户会给你任务，你可以调用可用工具（含远程 Dify 应用与页面临时回调工具）完成；' +
  '请优先调用工具并基于真实返回结果回答，不要编造工具执行结果。';

export interface AgentLoopResult {
  /** 最终文本回复。 */
  text: string;
  /** 本轮完整对话记录（不含 system 消息），可直接作为下一轮 history。 */
  transcript: ChatMessage[];
}

/**
 * 按「轮」裁剪历史，保留最近 maxTurns 轮（一轮 = 1 条 user 消息 + 其后全部 assistant/tool 消息）。
 *
 * 设计动机：history 中 assistant 消息可能携带 tool_calls，其后必须紧跟对应 toolCallId 的 tool 消息
 * （OpenAI 兼容协议）。按条数裁剪会切出孤儿 tool 消息导致 API 报错，因此裁剪单位必须为「轮」，
 * 且切点落在 user 消息上——保证 assistant tool_calls 与 tool 消息的配对完整。
 *
 * 边界：maxTurns <= 0（或非法非整数）表示不裁剪，原样返回浅拷贝；轮数不足 maxTurns 时同样原样返回。
 */
export function trimHistory(history: readonly ChatMessage[], maxTurns: number): ChatMessage[] {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) return [...history];
  const turnStarts: number[] = [];
  history.forEach((message, index) => {
    if (message.role === 'user') turnStarts.push(index);
  });
  if (turnStarts.length <= maxTurns) return [...history];
  // 从倒数第 maxTurns 个 user 消息起切片：切点必为 user，天然满足协议配对完整性
  return history.slice(turnStarts[turnStarts.length - maxTurns]);
}

/** 安全解析工具入参 JSON，失败返回 null。 */
function parseToolArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** runAgentLoop 的入参聚合（对象入参，满足参数 ≤ 3 约束）。 */
export interface AgentLoopParams {
  /** 对话历史，必须以最新的用户消息结尾（不含 system 消息）。 */
  history: readonly ChatMessage[];
  /** 本任务可用工具（静态清单；可为空：此时模型只能纯文本回答）。 */
  tools: readonly AgentTool[];
  /** 循环依赖（LLM 客户端、工具清单提供者与工具执行器）。 */
  deps: AgentLoopDeps;
  /** 循环选项（缺省全部回退内置默认值）。 */
  options?: AgentLoopOptions;
}

/** 执行单个工具调用并生成回填消息内容（错误也文本化回填，让模型自我纠正）。 */
async function executeSingleTool(
  call: ToolCallRequest,
  deps: AgentLoopDeps,
  onEvent: (event: AgentLoopEvent) => void
): Promise<string> {
  onEvent({ type: 'tool_start', name: call.function.name });
  const args = parseToolArgs(call.function.arguments);
  if (args === null) {
    onEvent({ type: 'tool_error', name: call.function.name, error: '工具入参不是合法的 JSON 对象' });
    return '错误：工具入参不是合法的 JSON 对象，请修正后重试。';
  }
  try {
    const result = await deps.executeTool(call.function.name, args);
    const serialized = JSON.stringify(result) ?? 'null';
    onEvent({ type: 'tool_result', name: call.function.name, result: serialized });
    return serialized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onEvent({ type: 'tool_error', name: call.function.name, error: message });
    return `错误：${message}`;
  }
}

/**
 * 运行一轮 agent 对话循环。
 *
 * @param params.history 对话历史，必须以最新的用户消息结尾（不含 system 消息）
 * @param params.tools 本任务可用工具（静态清单；deps.listTools 提供时每轮以最新清单为准）
 * @returns 最终文本与完整对话记录
 */
export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { history, deps } = params;
  const options = params.options ?? {};
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxIterations = options.maxIterations ?? 8;
  const onEvent = options.onEvent ?? (() => {});
  const signal = options.signal;

  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw new AgentAbortError();
    }
  };

  const internal: ChatMessage[] = [...history];
  // transcript 与 internal 同构但不含 system（system 在请求时临时拼接）。
  const transcript: ChatMessage[] = [...internal];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    throwIfAborted();
    onEvent({ type: 'llm_call', iteration });
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...internal];
    // 每轮取最新工具清单（临时工具超时移除后 LLM 后续迭代视野内消失）；缺省回退静态清单
    const currentTools = deps.listTools !== undefined ? deps.listTools() : params.tools;
    const assistant = await deps.llm.complete(messages, currentTools, signal);
    throwIfAborted();
    internal.push(assistant);
    transcript.push(assistant);

    const toolCalls = assistant.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { text: assistant.content, transcript };
    }

    // assistant 消息无文本时协议要求 content 允许为空串，保持显式空串即可。
    for (const call of toolCalls) {
      throwIfAborted();
      const toolContent = await executeSingleTool(call, deps, onEvent);
      const toolMessage: ChatMessage = { role: 'tool', content: toolContent, toolCallId: call.id };
      internal.push(toolMessage);
      transcript.push(toolMessage);
    }
  }

  return {
    text: `已达到工具调用迭代上限（${maxIterations} 次），任务未完成。请缩小任务范围后重试。`,
    transcript,
  };
}
