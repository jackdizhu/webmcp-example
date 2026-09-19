// 调用日志门面：埋点侧唯一入口。逐条同步落库 + 超限轮转，落库失败不影响主流程。
// 总体：record 异步写库（append → count → 超限删最旧），异常只经 onError 上报；
// 举例：handle.ts 在 chat / run-agent 各关键节点调用 record；未接入存储时为 no-op。
import { computeRotateCount } from './logger-core';
import type { CallLogEntry, LogStorage } from './logger-types';

/** 埋点侧使用的日志器接口（no-op 实现 = 未接入存储时的零开销缺省）。 */
export interface CallLogger {
  /** 记录一条日志（异步落库，不抛异常：失败经 onError 上报）。 */
  record(entry: CallLogEntry): void;
  /** 读出全部日志（导出用；未接入存储返回空数组）。 */
  readAll(): Promise<CallLogEntry[]>;
  clear(): Promise<void>;
}

/** 逐条写库并按需轮转（append → count → 超限删最旧）。 */
export async function appendLog(storage: LogStorage, entry: CallLogEntry): Promise<void> {
  await storage.append([entry]);
  const total = await storage.count();
  const rotateCount = computeRotateCount(total);
  if (rotateCount > 0) await storage.deleteOldest(rotateCount);
}

/** 创建调用日志器；storage 缺省（未接入）时返回 no-op 实现。 */
export function createCallLogger(
  storage: LogStorage | undefined,
  onError: (error: Error) => void = (error) => {
    console.warn('web-agent-worker 调用日志落库失败', error);
  }
): CallLogger {
  if (storage === undefined) {
    return {
      record: () => {},
      readAll: async () => [],
      clear: async () => {},
    };
  }
  // 写入串行化：record 同步并发发起时，append → count → rotate 必须逐条独占执行。
  // 若并发交错，多条链会在同一次 count 波次看到相同总数，各自触发轮转导致多删
  // （200 条并发写会把库清空）。链式排队保证每条写完再处理下一条。
  let writeQueue: Promise<void> = Promise.resolve();
  return {
    record: (entry) => {
      writeQueue = writeQueue
        .then(() => appendLog(storage, entry))
        .catch((error: unknown) => {
          onError(error instanceof Error ? error : new Error(String(error)));
        });
    },
    readAll: () => storage.readAll(),
    clear: () => storage.clear(),
  };
}
