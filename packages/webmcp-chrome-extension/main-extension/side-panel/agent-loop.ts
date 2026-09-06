// agent 循环：纯逻辑模块，不依赖浏览器 API，便于单元测试。
//
// 职责：把用户消息 + 页面工具清单交给 LLM，若 LLM 返回工具调用则执行并把
// 结果回填对话，循环直到 LLM 给出最终文本回复或达到迭代上限。
// 对话消息结构与 OpenAI 兼容的 chat completions 工具调用协议对齐。

/** 透传给 LLM 的页面工具元数据（schema 原样保留）。 */
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

/** 对话消息（本扩展内部对话状态的统一形态）。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 仅 assistant 消息可能携带的工具调用请求。 */
  toolCalls?: ToolCallRequest[];
  /** 仅 tool 消息携带：对应的工具调用 id。 */
  toolCallId?: string;
}

/** LLM 客户端接口（由 llm-client.ts 提供 OpenAI 兼容实现，测试可注入桩）。 */
export interface LlmChatClient {
  complete(
    messages: readonly ChatMessage[],
    tools: readonly AgentTool[],
    signal?: AbortSignal
  ): Promise<ChatMessage>;
}

/** 循环过程事件，供 UI 实时展示工具执行进度。 */
export type AgentLoopEvent =
  | { type: 'llm_call'; iteration: number }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'tool_error'; name: string; error: string };

/** 循环依赖项。 */
export interface AgentLoopDeps {
  llm: LlmChatClient;
  /** 执行单个页面工具；抛异常视为执行失败（错误内容会回填给模型）。 */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** 循环被终止时抛出（侧栏据此把本轮消息标记为「已终止」而非报错）。 */
export class AgentAbortError extends Error {
  constructor() {
    super('本轮对话已被用户终止');
    this.name = 'AgentAbortError';
  }
}

/** 循环选项。 */
export interface AgentLoopOptions {
  /** 系统提示词，缺省使用内置的页面工具验证助手提示。 */
  systemPrompt?: string;
  /** 工具调用迭代上限，防止模型无限循环，默认 8。 */
  maxIterations?: number;
  /** 过程事件回调。 */
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * 终止信号：每次 LLM 调用与工具执行前检查，已中止则抛 AgentAbortError
   * 并停止后续迭代（正在执行的页面工具调用无法真正中断，等待其完成后停止）。
   */
  signal?: AbortSignal;
}

export const DEFAULT_SYSTEM_PROMPT =
  '你是浏览器页面 WebMCP 工具验证助手。用户会要求你验证当前页面暴露的工具；' +
  '请优先调用页面工具并基于真实返回结果回答，不要编造工具执行结果。';

export interface AgentLoopResult {
  /** 最终文本回复。 */
  text: string;
  /** 本轮完整对话记录（不含 system 消息），可直接作为下一轮 history。 */
  transcript: ChatMessage[];
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

/**
 * 运行一轮 agent 对话循环。
 *
 * @param history 对话历史，必须以最新的用户消息结尾（不含 system 消息）
 * @param tools 当前页面可用工具（可为空：此时模型只能纯文本回答）
 * @returns 最终文本与完整对话记录
 */
export async function runAgentLoop(
  history: readonly ChatMessage[],
  tools: readonly AgentTool[],
  deps: AgentLoopDeps,
  options: AgentLoopOptions = {}
): Promise<AgentLoopResult> {
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
    const assistant = await deps.llm.complete(messages, tools, signal);
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
      onEvent({ type: 'tool_start', name: call.function.name });
      const args = parseToolArgs(call.function.arguments);
      let toolContent: string;
      if (args === null) {
        onEvent({ type: 'tool_error', name: call.function.name, error: '工具入参不是合法的 JSON 对象' });
        toolContent = '错误：工具入参不是合法的 JSON 对象，请修正后重试。';
      } else {
        try {
          const result = await deps.executeTool(call.function.name, args);
          const serialized = JSON.stringify(result) ?? 'null';
          toolContent = serialized;
          onEvent({ type: 'tool_result', name: call.function.name, result: serialized });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolContent = `错误：${message}`;
          onEvent({ type: 'tool_error', name: call.function.name, error: message });
        }
      }
      const toolMessage: ChatMessage = { role: 'tool', content: toolContent, toolCallId: call.id };
      internal.push(toolMessage);
      transcript.push(toolMessage);
    }
  }

  return {
    text: `已达到工具调用迭代上限（${maxIterations} 次），任务未完成。请缩小验证范围后重试。`,
    transcript,
  };
}
