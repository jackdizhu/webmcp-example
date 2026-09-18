// 会话持久化门面（sessions 三件套之三，对齐 logger.ts 门面范式）：
// 库打开 + 读写编排（保存 = 事务内 upsert + 按 updatedAt 淘汰；加载 = 读取 + 截取最近 N 条）。
// 红线：任何失败都静默降级（console.error 留痕），不阻塞对话主流程 —— 会话功能
// 不可用时对话照常，只是没有历史。淘汰/截取决策在 session-core（可单测），本层零决策。
// 并发模型（2026-09-18 预留 tab-invoked 后台任务多会话）：saveSession 是参数化入口，
// 不绑定侧栏 UI 游标，任意会话快照可并发调用；「写入+淘汰」原子收口 IO 层单事务
// （putAndTrim），并发 readwrite 事务由 IndexedDB 串行调度，杜绝交叉竞态。
// 配置上限由调用方每次传入，改配置即时生效。
import { evictionIds, sliceRecent, type StoredChatSession } from './session-core';
import { openSessionDb, type SessionDb } from './session-db';

let db: SessionDb | null = null;

/** 打开会话库（侧栏启动时调用一次；失败静默降级为无会话功能）。 */
export async function initSessionStore(): Promise<void> {
  if (db) return;
  try {
    db = await openSessionDb();
  } catch (error) {
    console.error('会话库初始化失败:', error);
    db = null;
  }
}

/** 会话库是否可用（测试/调试与提示分支用）。 */
export function isSessionStoreAvailable(): boolean {
  return db !== null;
}

/**
 * 把待持久化会话归一化为 plain 对象再入 IO 层。
 * 动机：App 传入的 messages/llmHistory 深处是 Vue reactive 代理，IndexedDB 的
 * structured clone 无法克隆 proxy（DataCloneError）；这些字段全部是可 JSON 化的
 * 纯数据（字符串/数组/字面量），JSON round-trip 是最可靠的快照剥离手段。
 */
function toPlainSession(session: StoredChatSession): StoredChatSession {
  return JSON.parse(JSON.stringify(session)) as StoredChatSession;
}

/**
 * 保存（upsert）单个会话并执行淘汰：单 readwrite 事务内完成「写入 + 全量快照 +
 * 按 updatedAt 保留最近 retentionLimit 条、删除其余」（淘汰决策 =
 * session-core.evictionIds，与 trimSessions 语义严格一致）。
 * 并发安全：任意会话快照可同时调用（侧栏轮次归档 × 后台任务归档），事务层串行保证
 * 互不吞写、不误删对方刚更新的记录。
 */
export async function saveSession(
  session: StoredChatSession,
  retentionLimit: number
): Promise<void> {
  if (!db) return;
  try {
    await db.putAndTrim(toPlainSession(session), (all) => evictionIds(all, retentionLimit));
  } catch (error) {
    console.error('会话保存失败:', error);
  }
}

/** 读取最近 loadLimit 个会话（按 updatedAt 降序；失败/库不可用返回空数组）。 */
export async function loadRecentSessions(loadLimit: number): Promise<StoredChatSession[]> {
  if (!db) return [];
  try {
    const all = await db.listAll();
    return sliceRecent(all, loadLimit);
  } catch (error) {
    console.error('会话读取失败:', error);
    return [];
  }
}

/** 当前会话条数（设置页/调试展示预留；库不可用返回 0）。 */
export async function sessionCount(): Promise<number> {
  if (!db) return 0;
  try {
    return await db.count();
  } catch (error) {
    console.error('会话计数失败:', error);
    return 0;
  }
}
