// Tab 页签反调任务执行器（webmcp-agent-chat-core，纯领域模块）。
//
// 职责（见 docs/webmcp-chrome-extension-tab-invoked-agent-task-explore.md §4）：
// - 智能体解析：agentId 优先（Q8），其次 agentName 精确匹配（重名 → AMBIGUOUS_AGENT_NAME）；
// - 技能解析：skillName 按 SkillSummary.name 精确匹配（Q7），命中后以 L1 清单注入系统提示词，
//   并确保 __agent_load_skill 工具在列（模型按需懒加载 L2 全文）；
// - 任务执行：runAgentLoop 直连（不经 chatController，R4 —— 任务自持会话后台运行，
//   与侧栏手打对话并行互斥），history 仅一条 user 消息（agentPrompt）。
//
// 边界红线：零 chrome.*、零 Vue、零宿主依赖；平台适配（LLM 客户端、工具执行、
// 会话归档、超时与队列）全部由宿主（side-panel/runtime/agent-task-host）注入。
import {
  runAgentLoop,
  type AgentLoopEvent,
  type AgentTool,
  type ChatMessage,
  type LlmChatClient,
} from './agent-loop';
import type { AgentProfile } from './agent-profile';
import { composeSystemPrompt } from './agent-profile';
import { buildSkillL1Section, createSkillToolDefinition, SKILL_TOOL_NAME, type SkillSummary } from './skill-loader';

/** 任务执行失败错误（宿主据此映射协议错误码；signal 中止以 AgentAbortError 原样透传）。 */
export class AgentTaskRunnerError extends Error {
  constructor(
    /** 错误语义码：与协议错误码同名子集，宿主直接映射。 */
    readonly code: 'AGENT_NOT_FOUND' | 'AMBIGUOUS_AGENT_NAME' | 'SKILL_NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'AgentTaskRunnerError';
  }
}

/**
 * 解析目标智能体：agentId 非空时按 id 精确解析（优先，Q8）；否则按 name 精确匹配。
 * id 未命中 / name 无匹配 → AGENT_NOT_FOUND；name 命中多条 → AMBIGUOUS_AGENT_NAME。
 */
export function resolveAgentProfile(
  agents: readonly AgentProfile[],
  selector: { agentId?: string; agentName?: string }
): AgentProfile {
  const agentId = selector.agentId?.trim() ?? '';
  if (agentId.length > 0) {
    const byId = agents.find((agent) => agent.id === agentId);
    if (!byId) {
      throw new AgentTaskRunnerError('AGENT_NOT_FOUND', `未找到 id 为「${agentId}」的智能体`);
    }
    return byId;
  }
  const agentName = selector.agentName?.trim() ?? '';
  const matches = agents.filter((agent) => agent.name === agentName);
  if (matches.length === 0) {
    throw new AgentTaskRunnerError('AGENT_NOT_FOUND', `未找到名为「${agentName}」的智能体`);
  }
  if (matches.length > 1) {
    const ids = matches.map((agent) => agent.id).join(', ');
    throw new AgentTaskRunnerError(
      'AMBIGUOUS_AGENT_NAME',
      `智能体名「${agentName}」匹配到 ${matches.length} 个档案（${ids}），请改用 agentId 精确指定`
    );
  }
  return matches[0] as AgentProfile;
}

/**
 * 解析任务技能：按 SkillSummary.name 精确匹配（Q7）。
 * 无匹配 → SKILL_NOT_FOUND；多条同名取第一个（清单由宿主来源决定，语义上单来源无重名）。
 */
export function resolveSkillSummary(
  summaries: readonly SkillSummary[],
  skillName: string
): SkillSummary {
  const match = summaries.find((item) => item.name === skillName);
  if (!match) {
    throw new AgentTaskRunnerError('SKILL_NOT_FOUND', `未找到名为「${skillName}」的技能`);
  }
  return match;
}

/** 任务执行依赖（宿主注入；与 AgentLoopDeps 同形，另带任务级选项）。 */
export interface AgentTaskRunDeps {
  /** LLM 客户端（宿主按全局 settings + profile.llmOverride 合并后创建，mergeLlmConfig 在宿主侧调用）。 */
  llm: LlmChatClient;
  /** 本轮可用工具清单（宿主 listTools 全量：页面工具 + 内置 + 注入）。 */
  tools: readonly AgentTool[];
  /** 单工具执行器（宿主缝：注入工具路由 + 页面工具透传）。 */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 全局 rules 提示词（settings.systemPrompt 语义，经 composeSystemPrompt 分层组装）。 */
  globalSystemPrompt: string;
  /** 工具调用迭代上限（缺省 8，对齐 agent-loop 默认）。 */
  maxIterations?: number;
  /** 过程事件回调（宿主据此记录任务日志）。 */
  onEvent?: (event: AgentLoopEvent) => void;
  /** 终止信号（用户在侧栏切到任务会话后点终止 → AgentAbortError → 任务 cancelled）。 */
  signal?: AbortSignal;
}

/** 任务执行结果（transcript 供宿主归档任务会话；不含 system 消息）。 */
export interface AgentTaskRunResult {
  /** 最终文本回复。 */
  text: string;
  /** 本轮完整对话记录（user → assistant/tool…）。 */
  transcript: ChatMessage[];
}

/** runAgentTask 入参聚合（参数 ≤ 3 约束）。 */
export interface AgentTaskRunParams {
  /** 已解析的目标智能体档案（resolveAgentProfile 产出）。 */
  profile: AgentProfile;
  /** 任务指令（本轮唯一 user 消息）。 */
  prompt: string;
  deps: AgentTaskRunDeps;
  /** 已解析的任务技能摘要（无技能任务缺省；exactOptionalPropertyTypes 下不显式传 undefined）。 */
  skillSummary?: SkillSummary;
}

/** 确保技能加载工具在列（缺失时追加，避免与宿主清单重复）。 */
function withSkillTool(tools: readonly AgentTool[]): AgentTool[] {
  if (tools.some((tool) => tool.name === SKILL_TOOL_NAME)) return [...tools];
  return [...tools, createSkillToolDefinition()];
}

/**
 * 执行一个 agent 任务（新会话语义：history 仅含本任务 prompt，不沾侧栏当前会话上下文）。
 *
 * 系统提示词 = composeSystemPrompt(profile, globalSystemPrompt, { skillSection })，
 * 与侧栏对话同一组装规则（[rules:global] / [rules:agent:*] / [skills] 分段）。
 * 技能任务额外把该技能的 L1 摘要注入 [skills] 段（Q7 懒加载：全文由模型调
 * __agent_load_skill 取得，执行器仍走宿主缝）。
 *
 * 错误语义：解析失败抛 AgentTaskRunnerError；用户终止抛 AgentAbortError；
 * 其余异常（LLM/工具）原样上抛，由宿主映射 EXECUTION_FAILED。
 */
export async function runAgentTask(params: AgentTaskRunParams): Promise<AgentTaskRunResult> {
  const { profile, prompt, deps } = params;
  const skillSummary = params.skillSummary;
  const skillSection =
    skillSummary !== undefined ? buildSkillL1Section([skillSummary]) : undefined;
  const systemPrompt = composeSystemPrompt(profile, deps.globalSystemPrompt, {
    ...(skillSection !== undefined ? { skillSection } : {}),
  });
  const history: ChatMessage[] = [{ role: 'user', content: prompt }];
  const tools = skillSummary !== undefined ? withSkillTool(deps.tools) : [...deps.tools];
  return runAgentLoop({
    history,
    tools,
    deps: { llm: deps.llm, executeTool: deps.executeTool },
    options: {
      systemPrompt,
      ...(deps.maxIterations !== undefined ? { maxIterations: deps.maxIterations } : {}),
      ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
  });
}
