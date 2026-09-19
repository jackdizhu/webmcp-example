// 调用日志类型定义：埋点层、决策层、IO 层共用的统一形态。
//
// 总体：为 chat / run-agent 调用链提供结构化调用日志，默认落 IndexedDB
// （滚动保留最近 200 条），支撑后续数据上报与日志导出。

/** 日志阶段（Key-Value 自解释，命名与 worker 消息语义对齐）。 */
export type CallLogPhase =
  | 'chat_request'
  | 'chat_done'
  | 'chat_error'
  | 'agent_accepted'
  | 'agent_done'
  | 'agent_error'
  | 'llm_call'
  | 'tool_start'
  | 'tool_result'
  | 'tool_error';

/**
 * 单条调用日志。
 *
 * 内容约定：记录请求/响应实际内容（query / answer / 工具结果 / transcript 等，
 * 超 8000 字符截断），供调用过程问题分析；api-key 等鉴权数据绝不落日志
 * （只进 Authorization 头）。
 */
export interface CallLogEntry {
  /** 关联一次完整调用的请求 id（worker 消息协议的 requestId）。 */
  requestId: string;
  /** 日志阶段。 */
  phase: CallLogPhase;
  /** 记录时间戳（毫秒）；IndexedDB ts 索引键，滚动删除按此升序。 */
  ts: number;
  /** 该阶段耗时（毫秒，仅终态类阶段携带）。 */
  durationMs?: number;
  /** 阶段附加数据（自解释 Key-Value，如 conversationId / iteration / 错误码）。 */
  payload: Record<string, unknown>;
}

/** 日志存储接口（IO 层实现 IndexedDB 版；单测注入内存桩）。 */
export interface LogStorage {
  append(entries: readonly CallLogEntry[]): Promise<void>;
  count(): Promise<number>;
  /** 按 ts 升序删除最旧 count 条（滚动清理）。 */
  deleteOldest(count: number): Promise<void>;
  /** 按 ts 升序读出全部条目（导出用）。 */
  readAll(): Promise<CallLogEntry[]>;
  clear(): Promise<void>;
}
