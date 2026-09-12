// LLM HTTP 协议适配层（共享库 webmcp-agent-chat-core）。
// 仅依赖 fetch —— 适配 openai-compat 与 anthropic 两个协议（R4 决策），注入 fetchImpl
// 供无 fetch 环境或单元测试替换。
//
// 埋点红线：日志只记 URL/模型/数量/耗时/状态，绝不记录 Authorization 头与消息体。
// 日志落点经 onLog 注入（宿主接自己的日志设施，如 side-panel 的 logEvent），
// 共享库不得反向依赖宿主模块；onLog 收到的 payload 不含鉴权信息，可原样落盘。
import type { AgentTool, ChatMessage, LlmChatClient } from './agent-loop';

/** 日志钩子：level 对齐常见日志分级，event 为事件名，payload 为结构化明细（不含鉴权数据）。 */
export type LlmLogFn = (level: 'debug' | 'info' | 'warn' | 'error', event: string, payload?: unknown) => void;

const noopLog: LlmLogFn = () => {};

/** apiPath 显式配置为空串时的提示文案（不回退默认路径，阻断请求）。 */
export const API_PATH_EMPTY_HINT = '请配置apiPath，如：/chat/completions';

/** LLM 服务配置（API Key 由宿主持有与持久化，禁止硬编码）。 */
export interface LlmConfig {
  apiKey: string;
  /** 形如 https://api.deepseek.com 的基础地址（不含请求路径；最终端点为 baseUrl + apiPath）。 */
  baseUrl: string;
  /**
   * 请求路径，拼接在 baseUrl 之后。openai-compat 默认 '/chat/completions'；
   * anthropic 默认 '/v1/messages'。
   * - 未提供（undefined）：按协议回退默认（兼容存量配置）。
   * - 显式空串：不回退默认路径，请求前直接抛出提示。
   */
  apiPath?: string;
  model: string;
  /** 协议类型（缺省 openai-compat 兼容存量配置）。 */
  apiProtocol?: 'openai-compat' | 'anthropic';
  /** Anthropic Messages API 必填的 max_tokens（缺省 4096；openai-compat 不消费）。 */
  maxTokens?: number;
}

/** OpenAI 兼容协议的 tool_call 形态。 */
interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: WireToolCall[];
    };
  }>;
}

/** 内部对话消息 → OpenAI 兼容请求消息（tool_calls 补充协议要求的 type 字段）。 */
export function toWireMessages(messages: readonly ChatMessage[]): WireMessage[] {
  return messages.map((message) => {
    const wire: WireMessage = { role: message.role, content: message.content };
    if (message.toolCalls) {
      wire.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: call.function,
      }));
    }
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId;
    return wire;
  });
}

/** 页面工具 → OpenAI 兼容 tools 声明。 */
export function toWireTools(tools: readonly AgentTool[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * 创建 OpenAI 兼容的 chat completions 客户端。
 *
 * @param config 服务配置
 * @param fetchImpl fetch 实现，默认全局 fetch（测试注入桩）
 * @param onLog 日志钩子（默认 no-op；宿主接入自己的日志设施）
 */
export function createOpenAiCompatClient(
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: LlmLogFn = noopLog
): LlmChatClient {
  return {
    async complete(messages, tools, signal) {
      // apiPath 语义：undefined 回退默认路径；显式空串不回退，阻断请求并提示配置
      const apiPath = config.apiPath ?? '/chat/completions';
      if (apiPath.trim().length === 0) throw new Error(API_PATH_EMPTY_HINT);
      const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
      const url = `${config.baseUrl.replace(/\/+$/, '')}${path}`;
      const body: Record<string, unknown> = {
        model: config.model,
        messages: toWireMessages(messages),
      };
      // 无工具时省略 tools 字段，兼容对空数组敏感的服务端
      if (tools.length > 0) body['tools'] = toWireTools(tools);

      onLog('info', 'llm_request', {
        url,
        model: config.model,
        messageCount: messages.length,
        toolCount: tools.length,
      });
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          // 用户终止时中断请求（AbortError 由 agent-loop 统一转义为已终止语义）
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        onLog('error', 'llm_error', {
          url,
          model: config.model,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        onLog('error', 'llm_error', {
          url,
          model: config.model,
          status: response.status,
          detail: detail.slice(0, 300),
        });
        throw new Error(`LLM 请求失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const message = data.choices?.[0]?.message;
      if (!message) {
        throw new Error('LLM 响应缺少 choices[0].message 字段');
      }
      onLog('info', 'llm_response', {
        url,
        model: config.model,
        elapsedMs: Date.now() - startedAt,
        hasToolCalls: message.tool_calls !== undefined,
        contentLength: (message.content ?? '').length,
      });
      return {
        role: 'assistant',
        content: message.content ?? '',
        // exactOptionalPropertyTypes：仅在存在时携带 tool_calls，避免显式赋 undefined
        ...(message.tool_calls ? { toolCalls: message.tool_calls } : {}),
      };
    },
  };
}

// ---- Anthropic Messages 适配器 ----

/** Anthropic Messages API 版本（当前稳定版）。 */
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic max_tokens 缺省值（协议必填）。 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result 块专用字段。 */
  tool_use_id?: string;
  content?: string;
}

interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  error?: { type?: string; message?: string };
}

/** 内部对话消息 → Anthropic messages 数组（system 拆出；tool 消息并入 tool_result）。 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): {
  system: string;
  messages: AnthropicWireMessage[];
} {
  const systemParts: string[] = [];
  const wire: AnthropicWireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.length > 0) systemParts.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      wire.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        // 入参协议侧为 JSON 字符串，Anthropic 要求对象；解析失败回填空对象让模型自我纠正
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments) as unknown;
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      wire.push({ role: 'assistant', content: blocks });
      continue;
    }
    // tool 消息 → user 消息中的 tool_result block；连续 tool 消息合并进同一条
    // user 消息（Anthropic 要求 tool_result 紧跟 tool_use 且承载于 user 侧）
    const block: AnthropicContentBlock = {
      type: 'tool_result',
      tool_use_id: message.toolCallId ?? '',
      content: message.content,
    };
    const last = wire[wire.length - 1];
    if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
      last.content.push(block);
    } else {
      wire.push({ role: 'user', content: [block] });
    }
  }
  return { system: systemParts.join('\n'), messages: wire };
}

/**
 * 创建 Anthropic Messages 协议客户端（tool_use / tool_result 与内部 OpenAI 形态的
 * 转换全部收在本适配器内，agent-loop 零改动）。
 *
 * @param config 服务配置（maxTokens 缺省 4096，协议必填）
 * @param fetchImpl fetch 实现，默认全局 fetch（测试注入桩）
 * @param onLog 日志钩子（默认 no-op）
 */
export function createAnthropicClient(
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: LlmLogFn = noopLog
): LlmChatClient {
  return {
    async complete(messages, tools, signal) {
      const apiPath = config.apiPath ?? '/v1/messages';
      if (apiPath.trim().length === 0) throw new Error('请配置apiPath，如：/v1/messages');
      const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
      const url = `${config.baseUrl.replace(/\/+$/, '')}${path}`;
      const { system, messages: wireMessages } = toAnthropicMessages(messages);
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: config.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
        messages: wireMessages,
      };
      if (system.length > 0) body['system'] = system;
      // 无工具时省略 tools 字段；入参用 input_schema（非 parameters）
      if (tools.length > 0) {
        body['tools'] = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        }));
      }

      onLog('info', 'llm_request', {
        url,
        protocol: 'anthropic',
        model: config.model,
        messageCount: messages.length,
        toolCount: tools.length,
      });
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        onLog('error', 'llm_error', {
          url,
          protocol: 'anthropic',
          model: config.model,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        onLog('error', 'llm_error', {
          url,
          protocol: 'anthropic',
          model: config.model,
          status: response.status,
          detail: detail.slice(0, 300),
        });
        throw new Error(`LLM 请求失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      const blocks = data.content ?? [];
      const content = blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('');
      const toolCalls = blocks
        .filter((block) => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
        .map((block) => ({
          id: block.id as string,
          function: {
            name: block.name as string,
            // Anthropic 入参为对象；内部协议为 JSON 字符串，序列化回填
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      if (content.length === 0 && toolCalls.length === 0) {
        throw new Error('LLM 响应缺少 content 内容块');
      }
      onLog('info', 'llm_response', {
        url,
        protocol: 'anthropic',
        model: config.model,
        elapsedMs: Date.now() - startedAt,
        hasToolCalls: toolCalls.length > 0,
        contentLength: content.length,
      });
      return {
        role: 'assistant',
        content,
        // exactOptionalPropertyTypes：仅在存在时携带 tool_calls，避免显式赋 undefined
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },
  };
}

// ---- 协议分发 ----

/**
 * 按协议类型创建 LLM 客户端（R4 决策：仅 openai-compat / anthropic 两个适配器）。
 * apiProtocol 缺省回退 openai-compat（兼容存量配置）。
 */
export function createLlmClient(
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: LlmLogFn = noopLog
): LlmChatClient {
  if (config.apiProtocol === 'anthropic') {
    return createAnthropicClient(config, fetchImpl, onLog);
  }
  return createOpenAiCompatClient(config, fetchImpl, onLog);
}
