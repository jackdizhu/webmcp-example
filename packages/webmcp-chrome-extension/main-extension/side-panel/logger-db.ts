// 本地日志 IndexedDB IO 层：扩展页私有源单库单表，ts 索引支持范围查询与滚动清理。
// jsdom 无 IndexedDB，本层不做浏览器内单测；滚动/裁剪的决策逻辑全部在 logger-core。
import {
  computeExcessCount,
  computeTimeCutoff,
  type LogEntry,
} from './logger-core';

const DB_NAME = 'webmcp-sidepanel-logs';
/** v2：新增 traceId 索引（对话轮次追踪）。 */
const DB_VERSION = 2;
const STORE = 'logs';

/** 日志存储接口（IO 层与门面解耦）。 */
export interface LoggerDb {
  append(entries: readonly LogEntry[]): Promise<void>;
  /** 滚动清理：先按 7 天时间窗删，再按条数上限删最旧。 */
  rotate(now: number): Promise<void>;
  /** 按时间升序读出全部条目（导出用）。 */
  readAll(): Promise<LogEntry[]>;
  /** 按 traceId 升序读出单轮全部条目（对话追踪用）。 */
  readByTrace(traceId: string): Promise<LogEntry[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

/** 打开（或创建）日志库。 */
export function openLoggerDb(
  factory: (name: string, version: number) => IDBOpenDBRequest = (name, version) =>
    indexedDB.open(name, version)
): Promise<LoggerDb> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      if (!db.objectStoreNames.contains(STORE)) {
        // 主键用自增 id：多条日志可能落在同一毫秒，ts 作主键会撞键
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts', 'ts', { unique: false });
        store.createIndex('traceId', 'traceId', { unique: false });
        return;
      }
      // v1 → v2 升级：补建 traceId 索引（既有条目无 traceId，索引对缺失键自动跳过）
      if (tx && !tx.objectStore(STORE).indexNames.contains('traceId')) {
        tx.objectStore(STORE).createIndex('traceId', 'traceId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      resolve(createLoggerDb(db));
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
}

/** 包装已打开的 IDBDatabase 为 LoggerDb。 */
export function createLoggerDb(db: IDBDatabase): LoggerDb {
  const runWrite = (action: (store: IDBObjectStore) => IDBRequest): Promise<void> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
    });

  return {
    async append(entries) {
      if (entries.length === 0) return;
      await runWrite((store) => {
        for (const entry of entries) store.add(entry);
        return null as unknown as IDBRequest;
      });
    },
    async rotate(now) {
      const cutoff = computeTimeCutoff(now);
      // 时间清理：ts 索引游标逐条删除（IDBObjectStore.delete 仅支持主键范围）
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).index('ts').openCursor(IDBKeyRange.upperBound(cutoff));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 时间清理失败'));
      });
      // 条数清理：count 超限后按 ts 升序游标删最旧
      const total = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB count 失败'));
      });
      const excess = computeExcessCount(total);
      if (excess <= 0) return;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).index('ts').openCursor();
        let remaining = excess;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || remaining <= 0) return;
          cursor.delete();
          remaining -= 1;
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 滚动清理失败'));
      });
    },
    async readAll() {
      return new Promise<Array<LogEntry & { id?: number }>>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).index('ts').getAll();
        req.onsuccess = () => resolve(req.result as Array<LogEntry & { id?: number }>);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
      }).then((records) =>
        // 剥离自增主键，保持 LogEntry 纯净形态
        records.map(({ id: _id, ...entry }) => entry)
      );
    },
    async readByTrace(traceId) {
      return new Promise<Array<LogEntry & { id?: number }>>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        // 兼容 v1 库未升级成功时的防御：索引不存在则返回空
        if (!store.indexNames.contains('traceId')) {
          resolve([]);
          return;
        }
        const req = store.index('traceId').getAll(IDBKeyRange.only(traceId));
        req.onsuccess = () => resolve(req.result as Array<LogEntry & { id?: number }>);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
      }).then((records) => records.map(({ id: _id, ...entry }) => entry));
    },
    async count() {
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB count 失败'));
      });
    },
    async clear() {
      await runWrite((store) => store.clear());
    },
  };
}
