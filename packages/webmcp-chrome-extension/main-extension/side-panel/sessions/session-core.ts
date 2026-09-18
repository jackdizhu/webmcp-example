// 会话持久化纯决策层（sessions 三件套之一，对齐 logger-core 范式）：
// 数据模型 + ID/标题生成 + 排序截取纯函数。零 IO、零 Vue、零 chrome.*，
// vitest 直测（jsdom 无 IndexedDB，IO 层不做浏览器内单测，决策全部收敛在此）。
import type { ChatMessage } from 'webmcp-agent-chat-core';
import type { TaskSessionStatus } from '../../../core/agent-task-protocol';
import type { UiMessage } from '../components/types';

/** 单个持久化会话快照（IndexedDB store `sessions` 记录，keyPath = id）。 */
export interface StoredChatSession {
  /** 会话 ID（sess_<时间戳base36>_<6位随机>，业务主键）。 */
  id: string;
  /** 展示标题（首条用户消息截断；未发过消息的空会话不持久化，故恒非空）。 */
  title: string;
  /** 会话创建/最近活跃时的激活智能体 ID（恢复时据此切回，见方案 D5）。 */
  agentId: string;
  /** 创建时间（毫秒时间戳）。 */
  createdAt: number;
  /** 最近活跃时间（每轮 turn 结束刷新；淘汰与「最近 N 条」排序依据）。 */
  updatedAt: number;
  /** UI 消息快照（含工具痕迹，恢复时整列表还原）。 */
  messages: UiMessage[];
  /** LLM 跨轮历史快照（恢复时经 controller.setHistory 回灌，方案 D2）。 */
  llmHistory: ChatMessage[];
  /**
   * 页签反调任务的发起页 origin（2026-09-18 C5 预留字段；普通侧栏会话缺省）。
   * 归档来源：SW 路由注入的可信 sender.origin（页面自报值不采信）。
   */
  origin?: string;
  /**
   * 任务会话状态（四态定稿：running 运行中 / cancelled 手动终止 / failed 执行异常 /
   * completed 执行完成）。普通侧栏会话缺省；任务会话由 agent-task-host 写入，
   * 开始时 running 归档、终态覆写（§4.6）。
   */
  taskStatus?: TaskSessionStatus;
}

const RANDOM_LENGTH = 6;
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 生成会话 ID：sess_<时间戳base36>_<6位随机>（同 trace-context 范式）。 */
export function createSessionId(
  now: number = Date.now(),
  random: () => number = Math.random
): string {
  let suffix = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    suffix += RANDOM_ALPHABET[Math.floor(random() * RANDOM_ALPHABET.length)];
  }
  return `sess_${now.toString(36)}_${suffix}`;
}

/** 会话标题截断长度（首条用户消息前 N 字）。 */
export const SESSION_TITLE_MAX_LENGTH = 20;

/** 由首条用户消息派生会话标题（trim 后截断；空输入返回空串）。 */
export function deriveSessionTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return trimmed.slice(0, SESSION_TITLE_MAX_LENGTH);
}

/** updatedAt 降序比较器（Array.sort 稳定，同 updatedAt 保持原序）。 */
const byUpdatedDesc = (a: StoredChatSession, b: StoredChatSession): number =>
  b.updatedAt - a.updatedAt;

/**
 * 淘汰截取：按 updatedAt 降序保留最近 limit 条（保存路径调用；limit 非正整数返回空数组，
 * 上限合法性由 loadSettings 归一化保证，此处防御性兜底）。
 */
export function trimSessions(
  sessions: readonly StoredChatSession[],
  limit: number
): StoredChatSession[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return [...sessions].sort(byUpdatedDesc).slice(0, limit);
}

/**
 * 计算超出 retention 上限应删除的 id 列表（trimSessions 的差集表达，供
 * session-db.putAndTrim 在单个事务内完成「写入 + 淘汰」，语义与 trimSessions 严格一致：
 * 保留 = trimSessions 的返回集合，删除 = 其余全部；limit 非正整数则全删）。
 */
export function evictionIds(
  sessions: readonly StoredChatSession[],
  limit: number
): string[] {
  const kept = new Set(trimSessions(sessions, limit).map((item) => item.id));
  return sessions.filter((item) => !kept.has(item.id)).map((item) => item.id);
}

/**
 * 展示截取：按 updatedAt 降序取最近 limit 条（侧栏打开加载路径；语义同 trimSessions，
 * 分开命名以区分「淘汰后剩余」与「展示截取」两个调用场景）。
 */
export function sliceRecent(
  sessions: readonly StoredChatSession[],
  limit: number
): StoredChatSession[] {
  return trimSessions(sessions, limit);
}
