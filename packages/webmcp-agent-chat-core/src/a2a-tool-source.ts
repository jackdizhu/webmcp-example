// A2A 工具源（共享库 webmcp-agent-chat-core，设计 §5 D3/D4/D6）。
//
// 职责：把已配置的远程 agent 暴露为本地 agent 循环可调用的工具（A2A-as-Tools）——
// 卡片摘要拼进工具 description（模型据此选择）、callTool 编排 message/send →
// （非终态时）tasks/get 轮询兜底、input-required 结构化返回 + taskId 续传、
// 统一 MCP CallToolResult 出口（与内置/页面/技能工具同一形状契约）。
//
// P0 决策约束（2026-09-12，设计 §7）：
// - 工具名 `a2a__<id>__send_task`，id（agentKey）稳定不变、cardUrl 可改 → 工具名不漂移；
// - 同一远程 agent 同时只允许一个进行中任务（串行守卫）；
// - input-required = isError:false 的结构化文本（taskId + 远端问题），由模型转述追问；
// - 阻塞式 message/send（无 SSE/push）；send 返回非终态时按 2s × 60 次 tasks/get 兜底轮询。
//
// 边界红线：纯逻辑，client 经参数注入，零 chrome.*、零 Vue。
import {
  isTerminalTaskState,
  messageToText,
  type A2aTask,
  type AgentCard,
} from './a2a-types';
import { A2aClientError, type A2aClient } from './a2a-client';
import type { AgentTool } from './agent-loop';
import type { LlmLogFn } from './llm-client';

/** 工具结果（MCP CallToolResult 同构，与内置/页面/技能工具形状一致）。 */
export interface A2aToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

/** 单个远程 agent 的运行配置（宿主从 profile.a2aAgents + settings token 解析而来）。 */
export interface A2aAgentConfig {
  /** agentKey：稳定不可变（决策 3），同时是工具名组成段，仅允许 [a-zA-Z0-9_-]。 */
  id: string;
  cardUrl: string;
  /** 每远程 agent 的 bearer token（宿主持有，只透传给 client，不落日志）。 */
  token?: string;
  /**
   * JSON-RPC 端点覆盖（可选）：message/send / tasks/get 的 POST 地址。
   * 缺省用卡片 supportedInterfaces[0].url；Dify 等实现卡片顶层 url 指向聊天页时必须覆盖。
   */
  endpointOverride?: string;
}

/** 阻塞式 message/send 的单请求超时（设计 §5 D8：默认 120s，可配）。 */
export const A2A_SEND_TIMEOUT_MS = 120_000;
/** 非终态兜底轮询参数（设计 §5 D6-4：间隔 2s、上限 60 次 ≈ 120s）。 */
export const A2A_POLL_INTERVAL_MS = 2_000;
export const A2A_POLL_MAX_ATTEMPTS = 60;

/** 工具名前缀（命名空间隔离，决策 1；与 chrome_extension_* 同款策略）。 */
export const A2A_TOOL_PREFIX = 'a2a__';
/** 单工具固定后缀。 */
export const A2A_SEND_TASK_SUFFIX = '__send_task';

/** 由 agentKey 生成工具名。 */
export function buildA2aToolName(agentId: string): string {
  return `${A2A_TOOL_PREFIX}${agentId}${A2A_SEND_TASK_SUFFIX}`;
}

/** 校验 agentKey：非空且仅 [a-zA-Z0-9_-]（保证工具名合法与命名空间可解析）。 */
export function validateA2aAgentId(id: string): string {
  if (id.length === 0 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`a2a agent id 非法（仅允许字母/数字/下划线/连字符）：${id}`);
  }
  return id;
}

/** 从工具名解析 agentKey；非 a2a__ 命名空间返回 null。 */
export function parseA2aToolName(name: string): string | null {
  if (!name.startsWith(A2A_TOOL_PREFIX) || !name.endsWith(A2A_SEND_TASK_SUFFIX)) return null;
  const id = name.slice(A2A_TOOL_PREFIX.length, name.length - A2A_SEND_TASK_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * 卡片 → 工具 description：拼入卡片 name/description 与 skills 摘要清单
 * （与 skill-loader 的 L1 清单同一动机：帮模型不经过额外查询就完成选型）。
 */
export function buildA2aToolDescription(card: AgentCard): string {
  const lines = [
    `委派任务给远程智能体「${card.name}」（A2A v${card.version}）：${card.description || '（无描述）'}`,
  ];
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

export interface A2aToolSourceDeps {
  /** A2A 客户端（宿主构造并注入；测试注入带桩 client 的源）。 */
  client: A2aClient;
  /** 阻塞 send 超时毫秒（缺省 A2A_SEND_TIMEOUT_MS）。 */
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
  /** agentKey → 运行配置。 */
  const configs = new Map<string, A2aAgentConfig>();
  /** agentKey → 校验后的卡片与工具定义（setAgents 成功后填充）。 */
  const entries = new Map<string, { config: A2aAgentConfig; card: AgentCard; tool: AgentTool }>();
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

      // ---- 入参校验（解析失败回填错误让模型自我纠正，对齐 agent-loop 语义）----
      const message = args['message'];
      if (typeof message !== 'string' || message.trim().length === 0) {
        return toErrorResult('入参缺少有效的 message（非空字符串）');
      }
      const rawTaskId = args['taskId'];
      if (rawTaskId !== undefined && (typeof rawTaskId !== 'string' || rawTaskId.trim().length === 0)) {
        return toErrorResult('入参 taskId 必须是非空字符串（来自上次工具结果）');
      }
      const taskId = typeof rawTaskId === 'string' ? rawTaskId.trim() : undefined;

      if (inFlight.has(agentId)) {
        return toErrorResult(`远程智能体 ${agentId} 已有进行中的任务，请等待其完成后再委派（P0 串行约束）`);
      }
      inFlight.add(agentId);
      const options = { token: entry.config.token, timeoutMs: sendTimeoutMs };
      // JSON-RPC 端点：显式覆盖优先（Dify 等实现卡片 url 指向聊天页），否则用卡片接口地址
      const endpoint = entry.config.endpointOverride ?? entry.card.supportedInterfaces[0]!.url;
      try {
        // ---- 阻塞式委派 ----
        const sendResult = await deps.client.sendMessage(
          endpoint,
          {
            role: 'user',
            parts: [{ kind: 'text', text: message }],
            messageId: nextMessageId(),
            ...(taskId !== undefined ? { taskId } : {}),
          },
          options
        );

        // 直达消息响应（远端不建任务，直接回答）：文本化即结果
        if (!sendResult.task) {
          const text = messageToText(sendResult.message);
          return toOkResult(text.length > 0 ? text : '（远端返回空消息）');
        }

        // ---- 非终态兜底轮询（tasks/get，间隔 2s × 60 次）----
        // 仅对 working/submitted 轮询；input-required 立即返回（决策 2：模型转述追问，
        // 用户答复后携 taskId 续传，远端任务挂起等待输入，轮询无意义）。
        let task = sendResult.task;
        let attempts = 0;
        let state = task.status.state;
        while (
          !isTerminalTaskState(state) &&
          state !== 'input-required' &&
          attempts < A2A_POLL_MAX_ATTEMPTS
        ) {
          attempts += 1;
          await wait(A2A_POLL_INTERVAL_MS);
          task = await deps.client.getTask(endpoint, task.id, options);
          state = task.status.state;
        }
        if (state === 'completed') {
          const text = taskResultText(task);
          onLog('info', 'a2a_task_completed', { agentId, taskId: task.id });
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
              `远端智能体需要补充信息才能继续（state: input-required）。`,
              `taskId: ${task.id}`,
              question.length > 0 ? `问题：\n${question}` : '问题：（远端未附带具体问题文本）',
              '请把上述问题转述给用户；拿到答复后携该 taskId 再次调用本工具继续同一任务。',
            ].join('\n')
          );
        }
        // 轮询耗尽仍未终态（working/submitted）
        onLog('warn', 'a2a_task_poll_exhausted', { agentId, taskId: task.id, state });
        return toErrorResult(
          `任务长时间未完成（taskId: ${task.id}，当前状态 ${state}，已等待约 ${Math.round(
            (A2A_POLL_INTERVAL_MS * attempts) / 1000
          )}s）。请稍后缩小任务范围重试。`
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
