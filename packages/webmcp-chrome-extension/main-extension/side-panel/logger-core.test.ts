// logger-core 纯逻辑单测：载荷脱敏截断、条目构造、滚动清理计算、JSONL 序列化、文件名。
import { describe, expect, it } from 'vitest';
import {
  computeExcessCount,
  computeTimeCutoff,
  createLogEntry,
  exportFileName,
  LOG_MAX_ENTRIES,
  LOG_RETENTION_MS,
  PAYLOAD_MAX_LENGTH,
  sanitizePayload,
  toJsonl,
  toLogLine,
} from './logger-core';

describe('sanitizePayload', () => {
  it('字符串原样返回', () => {
    expect(sanitizePayload('hello')).toBe('hello');
  });

  it('对象序列化为紧凑 JSON', () => {
    expect(sanitizePayload({ a: 1 })).toBe('{"a":1}');
  });

  it('超出上限截断并带标记', () => {
    const long = 'x'.repeat(PAYLOAD_MAX_LENGTH + 100);
    const out = sanitizePayload(long);
    expect(out.length).toBe(PAYLOAD_MAX_LENGTH + '…[已截断]'.length);
    expect(out.endsWith('…[已截断]')).toBe(true);
  });

  it('恰好等于上限不截断', () => {
    const exact = 'y'.repeat(PAYLOAD_MAX_LENGTH);
    expect(sanitizePayload(exact)).toBe(exact);
  });

  it('循环引用不抛异常', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => sanitizePayload(circular)).not.toThrow();
  });
});

describe('createLogEntry', () => {
  it('携带时间戳与级别，载荷经截断', () => {
    const entry = createLogEntry('warn', 'tools', 'tool_error', 'boom', 1000);
    expect(entry).toEqual({ ts: 1000, level: 'warn', source: 'tools', event: 'tool_error', payload: 'boom' });
  });

  it('未传载荷时不携带 payload 字段', () => {
    const entry = createLogEntry('info', 'app', 'sidepanel_opened', undefined, 1);
    expect('payload' in entry).toBe(false);
  });
});

describe('滚动清理计算', () => {
  it('时间下限 = now - 7 天', () => {
    expect(computeTimeCutoff(10_000_000)).toBe(10_000_000 - LOG_RETENTION_MS);
  });

  it('条数未超限删除 0 条', () => {
    expect(computeExcessCount(LOG_MAX_ENTRIES)).toBe(0);
    expect(computeExcessCount(100)).toBe(0);
  });

  it('条数超限删除最旧差值', () => {
    expect(computeExcessCount(LOG_MAX_ENTRIES + 50)).toBe(50);
  });
});

describe('JSONL 序列化', () => {
  it('单行为紧凑 JSON 且不含换行', () => {
    const line = toLogLine({ ts: 1, level: 'info', source: 'chat', event: 'turn_start', payload: 'a\nb' });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ ts: 1, event: 'turn_start' });
  });

  it('多行每条一行并以换行结尾；空数组输出为空', () => {
    const a = createLogEntry('info', 'chat', 'e1', undefined, 1);
    const b = createLogEntry('info', 'chat', 'e2', undefined, 2);
    const text = toJsonl([a, b]);
    expect(text.split('\n')).toHaveLength(3); // 两行数据 + 末尾换行产生的空串
    expect(text.endsWith('\n')).toBe(true);
    expect(toJsonl([])).toBe('');
  });
});

describe('exportFileName', () => {
  it('格式为 webmcp-sidepanel-YYYYMMDD-HHmmss.log', () => {
    // 本机时区构造：2026-09-05 22:30:08
    const name = exportFileName(new Date(2026, 8, 5, 22, 30, 8).getTime());
    expect(name).toBe('webmcp-sidepanel-20260905-223008.log');
  });

  it('月/日/时分秒补零', () => {
    const name = exportFileName(new Date(2026, 0, 3, 5, 4, 9).getTime());
    expect(name).toBe('webmcp-sidepanel-20260103-050409.log');
  });
});
