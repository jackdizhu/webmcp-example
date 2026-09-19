// 初始化推送/拉取 + 宿主关闭通知的载荷单源（C6 推送+拉取 / C7 宿主关闭通知）。
//
// 单源职责（两路同构的根基）：
// - 推送（C6）：侧栏 agent-init-pusher 对已连接页签 callTool `tab<id>__web_mcp_agent_initialization`；
// - 拉取（C6 R4）：页面 SDK asyncAgentInitialization() 经 C5 通道 → 宿主 init 分支；
//   两路共用 buildAgentInitPayload（同 schema 同白名单 = 「数据一致」的结构性保证）。
// - 关闭通知（C7）：侧栏关闭 → SW 广播/CS 自检 → CS relay callTool `web_mcp_agent_disconnect`。
//
// 脱敏红线（Q2/Q3 定案）：agents 仅 id/name/description（rules 全文、llmOverride 永不入
// 载荷）；a2aAgents 仅 id/name/protocol/enabled（cardUrl/endpoint/inputs 永不入载荷）；
// tools 含 inputSchema 全量（Q4）但按页签裁剪且不含通道工具本身（信道不是能力）。
//
// 分层红线：本模块 = 纯函数 + 常量 + 类型，零浏览器 API 零 chrome.* 依赖，vitest 直测。
import type { AgentTool } from './agent-loop';
import { a2aRefProtocol, type AgentA2aRef } from './a2a-config';
import type { AgentProfile } from './agent-profile';
import type { SkillSummary } from './skill-loader';

/** 页签自注册的初始化数据接收工具（C6：页面 handler 存快照 + CustomEvent）。 */
export const AGENT_INITIALIZATION_TOOL_NAME = 'web_mcp_agent_initialization';

/** 页签自注册的宿主关闭通知工具（C7：页面 handler 存快照 + CustomEvent）。 */
export const AGENT_DISCONNECT_TOOL_NAME = 'web_mcp_agent_disconnect';

/** 通道工具全集（Q7 不可见过滤 + Q3 预检 + Q10 红线「扩展不注册页签工具」的判定基准）。 */
export const AGENT_CHANNEL_TOOL_NAMES: readonly string[] = [
  AGENT_INITIALIZATION_TOOL_NAME,
  AGENT_DISCONNECT_TOOL_NAME,
];

/**
 * 剥掉页签工具暴露名上的 `tab<id>__` 前缀（panel-client rebuildRoutes 合成层添加）。
 * 无前缀（扩展侧工具 / 页面会话内裸名）原样返回。
 */
export function stripTabToolPrefix(exposedName: string): string {
  return exposedName.replace(/^tab\d+__/, '');
}

/** Q7：暴露名剥 `tab<id>__` 前缀后等于任一通道工具名即命中。 */
export function isAgentChannelTool(exposedName: string): boolean {
  return (AGENT_CHANNEL_TOOL_NAMES as readonly string[]).includes(stripTabToolPrefix(exposedName));
}

/** 过滤工具清单中的通道工具（Q7：agent 循环与任务宿主的工具供给收口用）。 */
export function excludeAgentChannelTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => !isAgentChannelTool(tool.name));
}

/** 快照（App 组装；tools 已按目标页签裁剪 = 该页签自身裸名工具 + 扩展侧工具）。 */
export interface AgentInitSnapshot {
  /** 全量档案；builder 内做白名单映射（rules/llmOverride 不出快照边界）。 */
  agents: readonly AgentProfile[];
  activeAgentId: string | null;
  /** a2aConfig 快照（token 本就不在其中，独立存储键持有）。 */
  a2aRefs: readonly AgentA2aRef[];
  skills: readonly SkillSummary[];
  tools: readonly AgentTool[];
}

/** 初始化载荷（结构化克隆安全：纯 JSON；页面 handler 存快照 + CustomEvent detail）。 */
export interface AgentInitPayload {
  version: 1;
  pushedAt: number;
  currentAgent: { id: string; name: string } | null;
  agents: Array<{ id: string; name: string; description: string }>;
  a2aAgents: Array<{ id: string; name: string; protocol: string; enabled: boolean }>;
  skills: Array<{ id: string; name: string; description: string }>;
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>;
}

/**
 * 构建初始化载荷（推送与拉取唯一出口；同输入恒同输出）。
 *
 * 白名单映射（脱敏红线）：
 * - agents → { id, name, description }；currentAgent = activeAgentId 命中的档案（未命中 → null）；
 * - a2aAgents → { id, name: displayName ?? id, protocol: 缺省 jsonrpc, enabled }
 *   （AgentA2aRef 无 name 字段，展示名与 a2a-tool-source 工具清单同口径：displayName 兜底 id）；
 * - skills → { id, name, description }（keywords 不入载荷）；
 * - tools → 原样四元组，但**内置剔除通道工具**（App 组装层已过滤，此处兜底防御——信道不是能力）。
 */
export function buildAgentInitPayload(snapshot: AgentInitSnapshot, now: number = Date.now()): AgentInitPayload {
  const agents = snapshot.agents.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
  }));
  const active = snapshot.agents.find((profile) => profile.id === snapshot.activeAgentId);
  return {
    version: 1,
    pushedAt: now,
    currentAgent: active ? { id: active.id, name: active.name } : null,
    agents,
    a2aAgents: snapshot.a2aRefs.map((ref) => ({
      id: ref.id,
      name: ref.displayName ?? ref.id,
      protocol: a2aRefProtocol(ref),
      enabled: ref.enabled,
    })),
    skills: snapshot.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })),
    tools: excludeAgentChannelTools(snapshot.tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

/** 宿主关闭通知载荷（C7 Q1：小载荷，预留 reason 枚举扩展位）。 */
export interface AgentDisconnectPayload {
  version: 1;
  event: 'disconnect';
  occurredAt: number;
}

/** 构建宿主关闭通知载荷（occurredAt = SW 广播/CS 自检确认时刻）。 */
export function buildAgentDisconnectPayload(now: number = Date.now()): AgentDisconnectPayload {
  return { version: 1, event: 'disconnect', occurredAt: now };
}
