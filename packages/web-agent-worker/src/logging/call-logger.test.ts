// call-logger 门面单测：内存桩存储覆盖正常（逐条写入 + 轮转触发）、边界（199/200）、异常（落库失败降级）场景。
import { describe, expect, it, vi } from 'vitest';
import { appendLog, createCallLogger } from './call-logger';
import type { CallLogEntry, LogStorage } from './logger-types';

/** 内存桩存储：按 ts 升序持有条目，deleteOldest 删最旧，可注入失败。 */
function createMemoryStorage(): LogStorage & { entries: CallLogEntry[]; failAppend: boolean } {
  const storage = {
    entries: [] as CallLogEntry[],
    failAppend: false,
    async append(entries: readonly CallLogEntry[]) {
      if (storage.failAppend) throw new Error('模拟写入失败');
      storage.entries.push(...entries);
    },
    async count() {
      return storage.entries.length;
    },
    async deleteOldest(count: number) {
      storage.entries.sort((a, b) => a.ts - b.ts);
      storage.entries.splice(0, count);
    },
    async readAll() {
      return [...storage.entries].sort((a, b) => a.ts - b.ts);
    },
    async clear() {
      storage.entries = [];
    },
  };
  return storage;
}

function makeEntry(ts: number): CallLogEntry {
  return { requestId: 'wa-req-1', phase: 'llm_call', ts, payload: {} };
}

/** 排空微任务队列（record 为 fire-and-forget，断言前需等待落库完成）。 */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('appendLog', () => {
  it('逐条写入并按 (总数 - 200) + 10 轮转', async () => {
    const storage = createMemoryStorage();
    storage.entries = Array.from({ length: 220 }, (_, index) => makeEntry(index));
    await appendLog(storage, makeEntry(999));
    // 写入后 221 条 → 删 31 → 剩 190
    expect(storage.entries.length).toBe(190);
    expect(storage.entries[0]?.ts).toBe(31);
  });

  it('未达上限不轮转', async () => {
    const storage = createMemoryStorage();
    await appendLog(storage, makeEntry(1));
    expect(storage.entries.length).toBe(1);
  });
});

describe('createCallLogger', () => {
  it('record 异步落库（不抛异常，等待后可见）', async () => {
    const storage = createMemoryStorage();
    const logger = createCallLogger(storage);
    logger.record(makeEntry(1));
    await flushMicrotasks();
    expect(storage.entries.length).toBe(1);
  });

  it('达到 200 条触发滚动删除最旧 10 条', async () => {
    const storage = createMemoryStorage();
    const logger = createCallLogger(storage);
    for (let ts = 0; ts < 200; ts += 1) {
      logger.record(makeEntry(ts));
    }
    await flushMicrotasks();
    expect(storage.entries.length).toBe(190);
    // 最旧的 10 条（ts 0-9）已被删除
    expect(storage.entries[0]?.ts).toBe(10);
    expect(storage.entries[189]?.ts).toBe(199);
  });

  it('199 条为滞后区间边界，不触发轮转', async () => {
    const storage = createMemoryStorage();
    const logger = createCallLogger(storage);
    for (let ts = 0; ts < 199; ts += 1) {
      logger.record(makeEntry(ts));
    }
    await flushMicrotasks();
    expect(storage.entries.length).toBe(199);
  });

  it('落库失败经 onError 上报且不影响调用方', async () => {
    const storage = createMemoryStorage();
    storage.failAppend = true;
    const onError = vi.fn();
    const logger = createCallLogger(storage, onError);
    expect(() => logger.record(makeEntry(1))).not.toThrow();
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('未接入存储时为 no-op（record 不抛、readAll 空）', async () => {
    const logger = createCallLogger(undefined);
    expect(() => logger.record(makeEntry(1))).not.toThrow();
    await expect(logger.readAll()).resolves.toEqual([]);
  });
});
