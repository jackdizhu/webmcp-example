// Dify-as-Tool：把 Dify 应用封装为 agent-loop 可调用工具
// （参考 chat-core a2a-tool-source.ts dify 分支形态，剥离 jsonrpc，V0-3 定案）。
import type { AgentTool } from '../loop/agent-loop';
import type { WebAgentDifyToolConfig } from '../protocol';
import type { DifyChatInput, DifyClient } from './dify-client';

/** 工具 id 合法字符（与 a2a__ / tab<id>__ 命名空间策略一致）。 */
const DIFY_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Dify 工具描述占位文案（配置 description 可为空）。 */
const DIFY_DESCRIPTION_PLACEHOLDER = '（无描述）';

/** 生成 Dify 工具名（命名空间：dify__<id>__chat）。 */
export function buildDifyChatToolName(id: string): string {
  return `dify__${id}__chat`;
}

/** 构建结果（tool 供 LLM 工具清单；execute 供 worker 内直连执行）。 */
export interface DifyChatTool {
  tool: AgentTool;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** 校验并规范化工具 id（非法字符直接抛错，fail-fast 于 init 装配期）。 */
export function requireDifyToolId(id: string): string {
  if (id.length === 0 || !DIFY_TOOL_ID_PATTERN.test(id)) {
    throw new Error(`Dify 工具 id 非法（限 [a-zA-Z0-9_-]）：${id}`);
  }
  return id;
}

/**
 * 构建 Dify chat 工具。
 * 入参：message（必填）、taskId（可选 = conversationId 续传）；
 * 结果文本化：answer + conversationId + 续传提示（模型据此决定是否延续会话）。
 */
export function buildDifyChatTool(config: WebAgentDifyToolConfig, deps: { client: DifyClient }): DifyChatTool {
  requireDifyToolId(config.id);
  const displayName = config.displayName !== undefined && config.displayName.length > 0 ? config.displayName : config.id;
  const description =
    config.description !== undefined && config.description.length > 0 ? config.description : DIFY_DESCRIPTION_PLACEHOLDER;
  const tool: AgentTool = {
    name: buildDifyChatToolName(config.id),
    description: [
      `委派任务给远程应用「${displayName}」（Dify REST）：${description}`,
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

  async function execute(args: Record<string, unknown>): Promise<unknown> {
    const message = args['message'];
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('入参缺少有效的 message（非空字符串）');
    }
    const rawTaskId = args['taskId'];
    if (rawTaskId !== undefined && (typeof rawTaskId !== 'string' || rawTaskId.trim().length === 0)) {
      throw new Error('入参 taskId 必须是非空字符串（来自上次工具结果）');
    }
    const input: DifyChatInput = {
      endpoint: config.endpoint,
      query: message,
      responseMode: config.responseMode ?? 'streaming',
      user: config.user,
      inputs: config.inputs ?? {},
      ...(rawTaskId !== undefined ? { conversationId: rawTaskId } : {}),
    };
    const result = await deps.client.chat(input, { token: config.apiKey });
    return [
      result.answer,
      ...(result.conversationId !== undefined
        ? [`conversationId: ${result.conversationId}`, `如需继续该会话请携带 taskId: ${result.conversationId}`]
        : []),
    ].join('\n');
  }

  return { tool, execute };
}
