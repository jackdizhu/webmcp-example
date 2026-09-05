// 日志门面：fire-and-forget 记录（失败静默，不阻塞对话主流程）、批量写入、导出与清理。
// 红线：任何记录路径都不得传入 API Key / 请求头；导出仅由用户主动触发。
import {
  createLogEntry,
  exportFileName,
  toJsonl,
  type LogLevel,
  type LogEntry,
} from './logger-core';
import { openLoggerDb, type LoggerDb } from './logger-db';
import { getCurrentTrace } from './trace-context';

/** 批量写入去抖间隔（毫秒）。 */
const FLUSH_INTERVAL_MS = 200;

let db: LoggerDb | null = null;
let queue: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 控制台输出开关（设置面板「控制台输出」，默认关：仅写 IndexedDB）。 */
let consoleEnabled = false;

/** 打开日志库并做一次滚动清理（侧栏启动时调用一次）。 */
export async function initLogger(): Promise<void> {
  if (db) return;
  try {
    db = await openLoggerDb();
    await db.rotate(Date.now());
  } catch {
    // 日志库不可用不影响主功能，写入时静默丢弃
    db = null;
  }
}

/** 设置控制台输出开关（设置面板「保存」后调用；默认关）。 */
export function setConsoleOutput(enabled: boolean): void {
  consoleEnabled = enabled;
}

/** 控制台同步输出一条日志（带 [traceId][source][event] 前缀，便于 DevTools 按 traceId 过滤）。 */
function printToConsole(entry: LogEntry): void {
  const prefix = `[${entry.traceId ?? '-'}][${entry.source}][${entry.event}]`;
  const args: unknown[] = [prefix, entry.payload ?? ''];
  switch (entry.level) {
    case 'debug':
      console.debug(...args);
      break;
    case 'info':
      console.info(...args);
      break;
    case 'warn':
      console.warn(...args);
      break;
    case 'error':
      console.error(...args);
      break;
  }
}

/** 立即落盘当前队列（内部用；导出/清空前也会调用）。 */
export async function flushLogs(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0 || !db) {
    queue = [];
    return;
  }
  const batch = queue;
  queue = [];
  try {
    await db.append(batch);
  } catch {
    // 静默失败：日志写入不阻塞业务
  }
}

/** 记录一条日志（自动附加当前轮 traceId；异步批量落盘，失败静默）。 */
export function logEvent(
  level: LogLevel,
  source: string,
  event: string,
  payload?: unknown
): void {
  const traceId = getCurrentTrace();
  const entry = createLogEntry(level, source, event, payload, Date.now(), traceId ?? undefined);
  if (consoleEnabled) {
    printToConsole(entry);
  }
  if (!db) return;
  queue.push(entry);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushLogs();
    }, FLUSH_INTERVAL_MS);
  }
}

/** 当前日志条数（库不可用返回 0）。 */
export async function logCount(): Promise<number> {
  await flushLogs();
  if (!db) return 0;
  try {
    return await db.count();
  } catch {
    return 0;
  }
}

/**
 * 导出全部日志为 JSONL 文件到下载目录（用户主动触发）。
 * @returns 导出文件名；库不可用或无条目时返回 null。
 */
export async function exportLogs(): Promise<string | null> {
  await flushLogs();
  if (!db) return null;
  let entries: LogEntry[];
  try {
    entries = await db.readAll();
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const blob = new Blob([toJsonl(entries)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const filename = exportFileName();
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    // 下载已由 Chrome 接管后释放对象 URL
    URL.revokeObjectURL(url);
  }
  return filename;
}

/** 按 traceId 读取单轮全部日志条目（对话追踪）。 */
export async function readLogsByTrace(traceId: string): Promise<LogEntry[]> {
  await flushLogs();
  if (!db) return [];
  try {
    return await db.readByTrace(traceId);
  } catch {
    return [];
  }
}

/** 清空全部日志（用户主动触发）。 */
export async function clearLogs(): Promise<void> {
  await flushLogs();
  if (!db) return;
  try {
    await db.clear();
  } catch {
    // 静默失败
  }
}
