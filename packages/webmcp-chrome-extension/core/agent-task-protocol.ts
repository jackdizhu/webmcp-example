// Tab 页签反调智能体任务协议（C5 反向通道，见 docs/webmcp-chrome-extension-tab-invoked-agent-task-explore.md §3）。
//
// 方向说明：既有通道（页面工具桥接 / relay）都是「扩展消费页面」；本协议是反方向 ——
// 页面（MAIN world SDK）→ content script → service worker → 侧边栏宿主，
// 让页面能请求扩展侧的 agent / tool 能力。
//
// C6 扩展（init-request/init-data）：页签主动拉取初始化数据，无任务语义 ——
// 不建会话、不进队列、无徽标；复用 create-task 的闸门与转发路径。
// C7 扩展（webmcp-host-status / host-status-query）：侧栏宿主关闭通知 ——
// SW 广播（chrome.tabs.sendMessage）与 CS 自检查询（chrome.runtime.sendMessage），
// 无 requestId、不进下方任何联合（与任务消息完全独立）。
//
// 分层红线：
// - 本模块 = 协议常量 + 线消息类型 + 入参校验纯函数，零 chrome.* 依赖，vitest 直测；
// - SW 只路由（D4）：来源信息由 SW 注入可信 sender（tabId/origin 取自 chrome 端口，
//   页面自报字段一律丢弃）；页面端不可信，CS 中转不校验业务语义；
// - 请求/响应以 requestId 关联：页面侧 Promise 在 task-done / task-error 时落定（Q1）。
//
// 心跳：CS 每 20s 向 SW 发 heartbeat，维持 SW 不因空闲被回收（长任务期间路由必须存活）。
import type { AgentInitPayload } from 'webmcp-agent-chat-core';

/** CS → SW 的 Port 名（每个需要发起任务的页签一条长连接）。 */
export const AGENT_TASK_TAB_PORT_NAME = 'webmcp-agent-task-tab';

/** 侧边栏宿主 → SW 的 Port 名（侧栏打开时建立；SW 据此判断宿主可用性）。 */
export const AGENT_TASK_HOST_PORT_NAME = 'webmcp-agent-task-host';

/** 协议版本（v2 预留 cancel-task 语义扩展时用于握手协商）。 */
export const AGENT_TASK_PROTOCOL_VERSION = 1;

/** 心跳间隔：低于 MV3 SW 30s 空闲回收阈值，保证长任务期间路由在线。 */
export const AGENT_TASK_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * origin 白名单的 chrome.storage.local 键（Q5）：设置页读写（字符串数组），
 * SW 路由只读 + storage.onChanged 刷新缓存。默认拒绝 = 键缺失/空数组。
 */
export const TAB_INVOKE_ALLOWLIST_KEY = 'tabInvokeAllowlist';

/** 任务终态（§3.4：协议层只有三种终态；「running」是会话展示态，不是协议终态）。 */
export type TaskTerminalStatus = 'completed' | 'failed' | 'cancelled';

/** 全部协议终态（守卫与遍历用）。 */
export const TASK_TERMINAL_STATUSES: readonly TaskTerminalStatus[] = ['completed', 'failed', 'cancelled'];

/** 任务会话展示状态（四态，2026-09-18 定稿：运行中/手动终止/执行异常/执行完成）。 */
export type TaskSessionStatus = 'running' | TaskTerminalStatus;

/** 判定未知值是否为协议终态。 */
export function isTaskTerminalStatus(value: unknown): value is TaskTerminalStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

/** 协议错误码（§3 全集；页面侧按 code 分支，message 仅供展示）。 */
export type AgentTaskErrorCode =
  | 'INVALID_PARAMS'
  | 'ORIGIN_NOT_ALLOWED'
  | 'EXTENSION_HOST_UNAVAILABLE'
  | 'QUEUE_FULL'
  | 'AGENT_NOT_FOUND'
  | 'AMBIGUOUS_AGENT_NAME'
  | 'SKILL_NOT_FOUND'
  | 'TOOL_NOT_FOUND'
  | 'AMBIGUOUS_TOOL_NAME'
  | 'TASK_TIMED_OUT'
  | 'EXECUTION_FAILED'
  | 'PROTOCOL_MISMATCH';

/** 全部错误码（守卫与测试遍历用）。 */
export const AGENT_TASK_ERROR_CODES: readonly AgentTaskErrorCode[] = [
  'INVALID_PARAMS',
  'ORIGIN_NOT_ALLOWED',
  'EXTENSION_HOST_UNAVAILABLE',
  'QUEUE_FULL',
  'AGENT_NOT_FOUND',
  'AMBIGUOUS_AGENT_NAME',
  'SKILL_NOT_FOUND',
  'TOOL_NOT_FOUND',
  'AMBIGUOUS_TOOL_NAME',
  'TASK_TIMED_OUT',
  'EXECUTION_FAILED',
  'PROTOCOL_MISMATCH',
];

/** 判定未知值是否为协议错误码。 */
export function isAgentTaskErrorCode(value: unknown): value is AgentTaskErrorCode {
  return typeof value === 'string' && (AGENT_TASK_ERROR_CODES as readonly string[]).includes(value);
}

// ---- 任务入参（页面侧提交的业务载荷）----

/** agent 任务入参（R1）：agentName/agentPrompt 必填；agentId 提供时优先于 agentName（Q8）。 */
export interface AgentTaskAgentInput {
  taskType: 'agent';
  /** 目标智能体展示名（按 name 解析；重名 → AMBIGUOUS_AGENT_NAME）。 */
  agentName: string;
  /** 任务指令（作为本轮 user 消息）。 */
  agentPrompt: string;
  /** 可选技能名：按 SkillSummary.name 精确匹配，命中后以 L1 注入该技能（Q7）。 */
  skillName?: string;
  /** 可选智能体 id：提供时优先按 id 精确解析（Q8）。 */
  agentId?: string;
}

/** tool 任务入参（R1）：一次性调用扩展侧工具，不进 agent 循环。 */
export interface AgentTaskToolInput {
  taskType: 'tool';
  /** 工具名，按 4 步解析（Q6：精确 → 调用方页签前缀 → 唯一后缀 → 歧义/未找到）。 */
  toolName: string;
  /** 工具入参（必须是普通对象，可为空对象）。 */
  toolProps: Record<string, unknown>;
}

/** 任务入参联合。 */
export type AgentTaskInput = AgentTaskAgentInput | AgentTaskToolInput;

/** 入参校验结果（ok = 归一化后的入参；失败恒为 INVALID_PARAMS + 可读原因）。 */
export type AgentTaskValidationResult =
  | { ok: true; input: AgentTaskInput }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

/** 判定未知值是否为普通对象（数组与 null 不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非空字符串（trim 后长度 > 0）；返回 trim 结果便于归一化。 */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 校验 agent 任务入参（宽容未知字段：只挑已知字段归一化，多余字段忽略）。
 * - agentId 为非空字符串时优先（Q8），此时 agentName 可缺省；
 * - agentName 缺失且无 agentId → INVALID_PARAMS。
 */
export function validateAgentTaskInput(value: unknown): AgentTaskValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, code: 'INVALID_PARAMS', message: '任务入参必须是对象' };
  }
  const agentId = nonEmptyString(value['agentId']);
  const agentName = nonEmptyString(value['agentName']);
  if (agentId === null && agentName === null) {
    return { ok: false, code: 'INVALID_PARAMS', message: '缺少目标智能体：agentName（或 agentId）必填' };
  }
  const agentPrompt = nonEmptyString(value['agentPrompt']);
  if (agentPrompt === null) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'agentPrompt 必填且不能为空' };
  }
  const skillName = nonEmptyString(value['skillName']);
  return {
    ok: true,
    input: {
      taskType: 'agent',
      agentName: agentName ?? '',
      agentPrompt,
      ...(skillName !== null ? { skillName } : {}),
      ...(agentId !== null ? { agentId } : {}),
    },
  };
}

/** 校验 tool 任务入参（toolName 必填；toolProps 必须是普通对象，缺省视为空对象）。 */
export function validateToolTaskInput(value: unknown): AgentTaskValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, code: 'INVALID_PARAMS', message: '任务入参必须是对象' };
  }
  const toolName = nonEmptyString(value['toolName']);
  if (toolName === null) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'toolName 必填且不能为空' };
  }
  const rawProps = value['toolProps'];
  if (rawProps !== undefined && !isPlainObject(rawProps)) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'toolProps 必须是普通对象（如 {}）' };
  }
  return {
    ok: true,
    input: {
      taskType: 'tool',
      toolName,
      toolProps: isPlainObject(rawProps) ? rawProps : {},
    },
  };
}

/** 按任务类型分发校验（taskType 非法 → INVALID_PARAMS）。 */
export function validateAgentTaskPayload(value: unknown): AgentTaskValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, code: 'INVALID_PARAMS', message: '任务入参必须是对象' };
  }
  if (value['taskType'] === 'agent') return validateAgentTaskInput(value);
  if (value['taskType'] === 'tool') return validateToolTaskInput(value);
  return { ok: false, code: 'INVALID_PARAMS', message: 'taskType 必须是 "agent" 或 "tool"' };
}

// ---- 线消息（CS ↔ SW ↔ 宿主 Port 上的信封）----

/** 页面任务结果载荷（Q1：asyncCreateAgentTask 的 Promise 落定值，§4.4）。 */
export interface AgentTaskResultPayload {
  taskId: string;
  sessionId: string;
  status: TaskTerminalStatus;
  /** agent 任务为最终回复文本；tool 任务为工具执行结果（原样透传）。 */
  result: unknown;
}

/** CS → SW：任务创建请求（payload 未校验，宿主侧统一走 validateAgentTaskPayload）。 */
export interface AgentTaskCreateMessage {
  type: 'create-task';
  requestId: string;
  payload: unknown;
}

/** CS → SW：心跳（长任务期间维持 SW 不被空闲回收）。 */
export interface AgentTaskHeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

/** SW → 宿主：注入可信来源后的任务创建消息（sender 由 SW 从 chrome 端口注入，页面自报值丢弃）。 */
export interface AgentTaskRoutedCreateMessage extends AgentTaskCreateMessage {
  sender: { tabId: number; origin: string };
}

/** 宿主 → SW → CS：任务受理回执（含宿主生成的任务与会话 ID；页面侧 Promise 保持挂起）。 */
export interface AgentTaskAckMessage {
  type: 'task-ack';
  requestId: string;
  taskId: string;
  sessionId: string;
}

/** 宿主 → SW → CS：任务终态推送（页面侧 Promise 在此落定）。 */
export interface AgentTaskDoneMessage {
  type: 'task-done';
  requestId: string;
  taskId: string;
  sessionId: string;
  status: TaskTerminalStatus;
  result: unknown;
}

/** SW/宿主 → CS：任务失败推送（code 分支处理；message 仅供展示）。 */
export interface AgentTaskErrorMessage {
  type: 'task-error';
  requestId: string;
  /** 已受理后才失败（如执行异常/超时）时携带；受理前失败（如白名单拒绝）缺省。 */
  taskId?: string;
  code: AgentTaskErrorCode;
  message: string;
}

/** v2 预留：页面主动取消任务（本期协议占位，宿主可回 PROTOCOL_MISMATCH）。 */
export interface AgentTaskCancelMessage {
  type: 'cancel-task';
  requestId: string;
  taskId: string;
}

/** CS → SW：初始化数据拉取请求（C6 R4；无任务语义，宿主直接回 init-data）。 */
export interface AgentTaskInitRequestMessage {
  type: 'init-request';
  requestId: string;
}

/** SW → 宿主：注入可信来源后的初始化拉取请求（sender 语义同 AgentTaskRoutedCreateMessage）。 */
export interface AgentTaskRoutedInitRequestMessage extends AgentTaskInitRequestMessage {
  sender: { tabId: number; origin: string };
}

/** 宿主 → SW → CS：初始化数据应答（页面侧 Promise 在此落定；无 ack，一跳直达）。 */
export interface AgentTaskInitDataMessage {
  type: 'init-data';
  requestId: string;
  payload: AgentInitPayload;
}

// ---- 宿主状态（C7：侧栏关闭通知；无 requestId，不进任何任务消息联合）----

/** SW → CS 的宿主状态广播（chrome.tabs.sendMessage 载荷；CS host-status-relay 消费）。 */
export interface AgentHostStatusBroadcast {
  type: 'webmcp-host-status';
  status: 'unavailable';
  occurredAt: number;
}

/** CS → SW 的一次性宿主存活查询（chrome.runtime.sendMessage；自检增强 Q7）。 */
export interface AgentHostStatusQuery {
  type: 'host-status-query';
}

/** SW → CS 查询应答（sendResponse；探测异常从严 hostAlive=true，宁可漏报不误报）。 */
export interface AgentHostStatusReply {
  type: 'host-status-reply';
  hostAlive: boolean;
}

/** 页面方向线消息联合（CS → SW）。 */
export type AgentTaskTabMessage =
  | AgentTaskCreateMessage
  | AgentTaskHeartbeatMessage
  | AgentTaskCancelMessage
  | AgentTaskInitRequestMessage;

/** 宿主方向线消息联合（宿主 → SW → CS）。 */
export type AgentTaskHostReplyMessage =
  | AgentTaskAckMessage
  | AgentTaskDoneMessage
  | AgentTaskErrorMessage
  | AgentTaskInitDataMessage;

/** 判定未知值是否为页面方向线消息（结构性最小校验：type + requestId）。 */
export function isAgentTaskTabMessage(value: unknown): value is AgentTaskTabMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['requestId'] !== 'string' || record['requestId'].length === 0) return false;
  return (
    record['type'] === 'create-task' ||
    record['type'] === 'heartbeat' ||
    record['type'] === 'cancel-task' ||
    record['type'] === 'init-request'
  );
}

/** 判定未知值是否为宿主方向线消息（结构性最小校验：type + requestId）。 */
export function isAgentTaskHostReplyMessage(value: unknown): value is AgentTaskHostReplyMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['requestId'] !== 'string' || record['requestId'].length === 0) return false;
  return (
    record['type'] === 'task-ack' ||
    record['type'] === 'task-done' ||
    record['type'] === 'task-error' ||
    record['type'] === 'init-data'
  );
}

/** 判定未知值是否为宿主状态广播（C7：type + status + occurredAt）。 */
export function isAgentHostStatusBroadcast(value: unknown): value is AgentHostStatusBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['type'] === 'webmcp-host-status' &&
    record['status'] === 'unavailable' &&
    typeof record['occurredAt'] === 'number'
  );
}

/** 判定未知值是否为宿主存活查询（C7 自检）。 */
export function isAgentHostStatusQuery(value: unknown): value is AgentHostStatusQuery {
  return (
    typeof value === 'object' && value !== null &&
    (value as Record<string, unknown>)['type'] === 'host-status-query'
  );
}

/** 判定未知值是否为宿主存活查询应答（C7 自检）。 */
export function isAgentHostStatusReply(value: unknown): value is AgentHostStatusReply {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record['type'] === 'host-status-reply' && typeof record['hostAlive'] === 'boolean';
}

// ---- 任务 ID ----

const TASK_ID_RANDOM_LENGTH = 6;
const TASK_ID_RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 生成任务 ID：task_<时间戳base36>_<6位随机>（与 createSessionId 同范式，可注入便于测试）。 */
export function createTaskId(now: number = Date.now(), random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < TASK_ID_RANDOM_LENGTH; i += 1) {
    suffix += TASK_ID_RANDOM_ALPHABET[Math.floor(random() * TASK_ID_RANDOM_ALPHABET.length)];
  }
  return `task_${now.toString(36)}_${suffix}`;
}
