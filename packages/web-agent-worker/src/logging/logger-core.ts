// 调用日志决策层（纯函数，jsdom 可单测）：与 IndexedDB IO 无关的轮转决策逻辑。
// IO 层（logger-db.ts）不做浏览器内单测，滚动清理数量全部由此层计算。

/** 日志条数上限：达到即触发滚动删除。 */
export const MAX_LOG_RECORDS = 200;
/** 每次轮转的额外删除余量：删后回落到 190，与上限形成 10 条滞后区间。 */
export const ROTATE_MARGIN = 10;
/** 单条内容字段的最大字符数（超长截断，防止单条日志占用过大）。 */
export const MAX_CONTENT_LENGTH = 8000;

/**
 * 计算滚动删除的最旧条数。
 *
 * 定义：总数不足 200 → 0；达到 200 → 删 (总数 - 200) + 10 条。
 * 举例：200 条删 10（剩 190）；205 条删 15（剩 190）；220 条删 30（剩 190）。
 * 详细：删除后回落到 190 条，逐条同步写入时每 10 条才触发一次轮转，
 * 削减 count + deleteOldest 事务频率约一半。
 */
export function computeRotateCount(total: number): number {
  if (!Number.isInteger(total) || total < MAX_LOG_RECORDS) return 0;
  return total - MAX_LOG_RECORDS + ROTATE_MARGIN;
}

/**
 * 截断超长内容到 max 字符，超长时追加截断标记。
 *
 * 定义：长度不超 max 原样返回；超长保留前 max 字符并追加 `…[截断，原文 N 字符]`。
 * 举例：truncateContent('ab', 3) → 'ab'；truncateContent('abcdef', 3) → 'abc…[截断，原文 6 字符]'。
 * 详细：统一约束 query / answer / 工具结果 / 对话记录等内容字段的单条体积，
 * 避免个别超大结果把单条日志与 200 条滚动容量撑爆。
 */
export function truncateContent(text: string, max: number = MAX_CONTENT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[截断，原文 ${text.length} 字符]`;
}
