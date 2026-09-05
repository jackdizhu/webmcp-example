// 本地日志纯逻辑层（与 IndexedDB / chrome.downloads IO 解耦，便于单测）。
// 红线：API Key 永不入日志；单条载荷截断防爆库；导出仅用户主动触发。

/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化日志条目（IndexedDB 存储 / JSONL 导出的统一形态）。 */
export interface LogEntry {
  /** 时间戳（epoch ms）。 */
  ts: number;
  level: LogLevel;
  /** 来源：chat（对话轮次）/ tools（agent 工具调用）/ debugger（调试手动执行）/ bridge（Port 链路）/ app（应用生命周期）/ llm（LLM 请求）。 */
  source: string;
  /** 事件名（短标识，如 turn_start、tool_result）。 */
  event: string;
  /** 载荷文本（已截断；无载荷为 undefined）。 */
  payload?: string;
  /** 对话轮次追踪 ID（无 trace 上下文的事件不带，如侧栏启动）。 */
  traceId?: string;
}

/** 单条载荷最大字符数（超出截断，防止大结果撑爆存储）。 */
export const PAYLOAD_MAX_LENGTH = 4096;

/** 日志条数上限（滚动清理：超出删最旧）。 */
export const LOG_MAX_ENTRIES = 2000;

/** 日志保留时长（毫秒）：7 天。 */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 截断标记。 */
const TRUNCATION_MARKER = '…[已截断]';

/** 判定未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把任意载荷序列化为文本并截断到上限。
 * 字符串原样使用；对象 JSON 序列化（失败回退 String()）。
 */
export function sanitizePayload(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (isRecord(value) || Array.isArray(value)) {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  if (text.length <= PAYLOAD_MAX_LENGTH) return text;
  return text.slice(0, PAYLOAD_MAX_LENGTH) + TRUNCATION_MARKER;
}

/** 构造一条日志条目（载荷统一走 sanitizePayload；traceId 由调用方从 TraceContext 传入）。 */
export function createLogEntry(
  level: LogLevel,
  source: string,
  event: string,
  payload: unknown,
  now: number,
  traceId?: string
): LogEntry {
  const hasPayload = payload !== undefined;
  return {
    ts: now,
    level,
    source,
    event,
    // exactOptionalPropertyTypes：仅在存在时携带可选字段，避免显式赋 undefined
    ...(hasPayload ? { payload: sanitizePayload(payload) } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
  };
}

/**
 * 计算滚动清理的时间下限：早于该时间戳的条目应删除。
 * 返回 null 表示无需按时间清理。
 */
export function computeTimeCutoff(now: number): number {
  return now - LOG_RETENTION_MS;
}

/**
 * 计算条数清理需要删除的最旧条数。
 * @param total 当前总条数；@param max 保留上限
 */
export function computeExcessCount(total: number, max: number = LOG_MAX_ENTRIES): number {
  return total > max ? total - max : 0;
}

/** 序列化条目为 JSONL 行（单行 JSON，无换行转义由 JSON 承担）。 */
export function toLogLine(entry: LogEntry): string {
  return JSON.stringify(entry);
}

/** 把条目数组序列化为 JSONL 文本（每行一条，末尾换行）。 */
export function toJsonl(entries: readonly LogEntry[]): string {
  return entries.map(toLogLine).join('\n') + (entries.length > 0 ? '\n' : '');
}

/** 生成导出文件名：webmcp-sidepanel-YYYYMMDD-HHmmss.log（本机时区）。 */
export function exportFileName(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `webmcp-sidepanel-${date}-${time}.log`;
}
