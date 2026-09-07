// OpenAI 兼容 LLM 客户端：DeepSeek / OpenAI / 其他 chat completions 兼容服务均可。
// 仅依赖 fetch（扩展页面上下文无 CORS 限制），注入 fetchImpl 以便单元测试。
// 埋点红线：日志只记 URL/模型/数量/耗时/状态，绝不记录 Authorization 头与消息体。
import type { AgentTool, ChatMessage, LlmChatClient } from './agent-loop';
import { logEvent } from './logger';

/** apiPath 显式配置为空串时的提示文案（不回退默认路径，阻断请求）。 */
export const API_PATH_EMPTY_HINT = '请配置apiPath，如：/chat/completions';

/** LLM 服务配置（API Key 存 chrome.storage.local，禁止硬编码）。 */
export interface LlmConfig {
  apiKey: string;
  /** 形如 https://api.deepseek.com 的基础地址（不含请求路径；最终端点为 baseUrl + apiPath）。 */
  baseUrl: string;
  /**
   * chat completions 请求路径，拼接在 baseUrl 之后。
   * - 未提供（undefined）：回退默认 '/chat/completions'（兼容存量配置）。
   * - 显式空串：不回退默认路径，请求前直接抛出 API_PATH_EMPTY_HINT 提示。
   */
  apiPath?: string;
  model: string;
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
 */
export function createOpenAiCompatClient(config: LlmConfig, fetchImpl: typeof fetch = fetch): LlmChatClient {
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

      logEvent('info', 'llm', 'llm_request', {
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
        logEvent('error', 'llm', 'llm_error', {
          url,
          model: config.model,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        logEvent('error', 'llm', 'llm_error', {
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
      logEvent('info', 'llm', 'llm_response', {
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
