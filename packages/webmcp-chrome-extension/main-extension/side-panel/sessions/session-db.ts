// 会话持久化 IndexedDB IO 层（sessions 三件套之二，对齐 logger-db 范式）：
// 扩展页私有源独立库单表，keyPath = 会话 id（业务主键，非自增），updatedAt 索引备用
// （当前读取统一 getAll 后由 session-core 内存排序，索引留给后续游标化演进）。
// 与日志库隔离：日志是可丢弃数据（设置页「清空日志」走 store.clear()），会话是用户
// 资产，同库共表会让清日志误删会话，故独立建库、互不影响。
// jsdom 无 IndexedDB，本层不做浏览器内单测；接口注入 factory 便于将来替换/桩测。
import type { StoredChatSession } from './session-core';

const DB_NAME = 'webmcp-sidepanel-sessions';
const DB_VERSION = 1;
const STORE = 'sessions';

/** 会话存储接口（IO 层与门面解耦）。 */
export interface SessionDb {
  get(id: string): Promise<StoredChatSession | null>;
  /** upsert：keyPath id 命中即覆盖（每轮结束后整会话快照重写）。 */
  put(session: StoredChatSession): Promise<void>;
  /**
   * 单 readwrite 事务内原子完成「upsert + 淘汰」：trimmer 收到事务内全量快照
   * （含刚写入的会话，同事务请求按序可见），返回应删除的 id 列表，删除在同事务发出。
   * 并发多个 saveSession 时 IndexedDB 保证 readwrite 事务串行，杜绝
   * 「陈旧快照过度淘汰 / delete 迭代期间误删并发更新的活跃会话」两类竞态。
   */
  putAndTrim(
    session: StoredChatSession,
    trimmer: (all: StoredChatSession[]) => string[]
  ): Promise<void>;
  delete(id: string): Promise<void>;
  /** 全量读取（上限 32 条的小数据集，getAll 足够；排序/截取决策在 session-core）。 */
  listAll(): Promise<StoredChatSession[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

/** 打开（或创建）会话库。 */
export function openSessionDb(
  factory: (name: string, version: number) => IDBOpenDBRequest = (name, version) =>
    indexedDB.open(name, version)
): Promise<SessionDb> {
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
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => {
      resolve(createSessionDb(request.result));
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
}

/** 包装已打开的 IDBDatabase 为 SessionDb。 */
export function createSessionDb(db: IDBDatabase): SessionDb {
  const runWrite = (
    action: (store: IDBObjectStore) => IDBRequest | void
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const result = action(tx.objectStore(STORE));
      void result; // 事务完成以 tx 事件为准，单个 request 结果仅由 onerror 冒泡
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
    });

  return {
    async get(id) {
      return new Promise<StoredChatSession | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve((req.result as StoredChatSession | undefined) ?? null);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
      });
    },
    async put(session) {
      await runWrite((store) => store.put(session));
    },
    putAndTrim(session, trimmer) {
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put(session);
        const getAll = store.getAll();
        // onsuccess 回调内同步发出 delete 请求（IndexedDB 事务在有 pending 请求期间
        // 不会自动提交，经典安全模式），保证「读快照 → 决策 → 删除」同事务原子生效
        getAll.onsuccess = () => {
          const all = (getAll.result ?? []) as StoredChatSession[];
          for (const id of trimmer(all)) {
            store.delete(id);
          }
        };
        getAll.onerror = () => tx.abort();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 保存/淘汰失败'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 保存/淘汰事务中止'));
      });
    },
    async delete(id) {
      await runWrite((store) => {
        store.delete(id);
      });
    },
    async listAll() {
      return new Promise<StoredChatSession[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as StoredChatSession[]);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
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
    async clear() {
      await runWrite((store) => {
        store.clear();
      });
    },
  };
}
