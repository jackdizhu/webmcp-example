// 对话追踪上下文（纯逻辑）：每轮 runTurn 生成唯一 traceId，logger 门面自动附加。
// 前提：runTurn 由 busy 锁保证严格串行，模块级 current 变量即为安全的当前轮上下文。

/** 当前轮的 traceId（无进行中轮次为 null，如侧栏启动、调试 Tab 手动执行）。 */
let current: string | null = null;

const RANDOM_LENGTH = 6;
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 生成 traceId：trace_<时间戳base36>_<6位随机>，如 trace_lz3k9f_a1b2c3。 */
export function generateTraceId(now: number = Date.now(), random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    suffix += RANDOM_ALPHABET[Math.floor(random() * RANDOM_ALPHABET.length)];
  }
  return `trace_${now.toString(36)}_${suffix}`;
}

/** 设置当前轮 traceId（runTurn 开头调用）。 */
export function setCurrentTrace(traceId: string): void {
  current = traceId;
}

/** 读取当前轮 traceId（无进行中轮次返回 null）。 */
export function getCurrentTrace(): string | null {
  return current;
}

/** 清除当前轮 traceId（runTurn finally 调用）。 */
export function clearCurrentTrace(): void {
  current = null;
}
