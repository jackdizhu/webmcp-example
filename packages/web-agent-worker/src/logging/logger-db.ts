// 调用日志 IndexedDB IO 层：worker 源单库单表，ts 索引支持范围查询与滚动清理。
// jsdom 无 IndexedDB，本层不做浏览器内单测；轮转决策逻辑全部在 logger-core（纯函数）。
// 总体：实现 LogStorage 接口；createLazyLogStorage 提供缺省接入
// （首次写入时才打开库，无 IndexedDB 环境首次失败后永久降级，避免逐条报错刷屏）。
import type { CallLogEntry, LogStorage } from './logger-types';

const DB_NAME = 'webmcp-worker-logs';
const DB_VERSION = 1;
const STORE = 'logs';

/** 打开（或创建）日志库。 */
export function openLoggerDb(
  factory: (name: string, version: number) => IDBOpenDBRequest = (name, version) =>
    indexedDB.open(name, version)
): Promise<LogStorage> {
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
      // 主键用自增 id：多条日志可能落在同一毫秒，ts 作主键会撞键
      const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('ts', 'ts', { unique: false });
    };
    request.onsuccess = () => {
      resolve(createLoggerDb(request.result));
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
}

/** 包装已打开的 IDBDatabase 为 LogStorage。 */
export function createLoggerDb(db: IDBDatabase): LogStorage {
  const runWrite = (action: (store: IDBObjectStore) => void): Promise<void> =>
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
      });
    },
    async count() {
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB count 失败'));
      });
    },
    async deleteOldest(count) {
      if (count <= 0) return;
      // 条数清理：ts 升序游标逐条删最旧（IDBObjectStore.delete 仅支持主键范围）
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).index('ts').openCursor();
        let remaining = count;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || remaining <= 0) return;
          cursor.delete();
          remaining -= 1;
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 滚动清理失败'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
      });
    },
    async readAll() {
      return new Promise<Array<CallLogEntry & { id?: number }>>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).index('ts').getAll();
        req.onsuccess = () => resolve(req.result as Array<CallLogEntry & { id?: number }>);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
      }).then((records) =>
        // 剥离自增主键，保持 CallLogEntry 纯净形态
        records.map(({ id: _id, ...entry }) => entry)
      );
    },
    async clear() {
      await runWrite((store) => {
        store.clear();
      });
    },
  };
}

/**
 * 缺省日志存储：首次使用时才打开 IndexedDB（零环境假设——不访问则零开销）。
 *
 * 首次失败（如环境无 IndexedDB / 版本被占用）即永久降级为空存储并回调 onError
 * 一次，避免逐条日志重复报错。后续可注入自定义 LogStorage 接管。
 */
export function createLazyLogStorage(onError?: (error: Error) => void): LogStorage {
  let storagePromise: Promise<LogStorage> | null = null;
  let broken = false;
  const run = async <T>(action: (storage: LogStorage) => Promise<T>, fallback: T): Promise<T> => {
    if (broken) return fallback;
    if (storagePromise === null) storagePromise = openLoggerDb();
    try {
      return await action(await storagePromise);
    } catch (error) {
      broken = true;
      onError?.(error instanceof Error ? error : new Error(String(error)));
      return fallback;
    }
  };

  return {
    append: (entries) => run((storage) => storage.append(entries), undefined),
    count: () => run((storage) => storage.count(), 0),
    deleteOldest: (count) => run((storage) => storage.deleteOldest(count), undefined),
    readAll: () => run((storage) => storage.readAll(), [] as CallLogEntry[]),
    clear: () => run((storage) => storage.clear(), undefined),
  };
}
