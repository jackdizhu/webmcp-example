// Worker 线程入口（消费方经 `web-agent-worker/worker` 导入后一行接线）。
//
// 库保持零环境假设：不创建自身全局作用域，由消费方持有 worker 入口文件并传入作用域
// （`new URL` 相对路径必须相对消费方源码，见设计 §4.1-1）。
//
// DOM/WebWorker lib 冲突规避（设计 §4.1-2）：不启用 WebWorker lib，
// 用最小结构化类型声明 worker 作用域（仅 onmessage / postMessage）。
import { createWorkerHandle } from './handle';
import type { WorkerToMainMessage } from '../protocol';
import { createLazyLogStorage } from '../logging/logger-db';
import type { LogStorage } from '../logging/logger-types';
import type { LlmLogFn } from '../loop/llm-client';

/** 最小结构化 worker 作用域（ DedicatedWorkerGlobalScope 的消费子集）。 */
export interface WebAgentWorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

/**
 * 启动 worker 消息处理：发送 ready 回执并挂接消息监听。
 *
 * @param scope worker 全局作用域（缺省 self；测试注入桩）
 * @param fetchImpl fetch 实现（缺省 self.fetch 解构后裸标识符持有，规避 Illegal invocation）
 * @param onLog 日志钩子（缺省 no-op；payload 不含鉴权数据）
 * @param logStorage 调用日志存储（缺省接入 IndexedDB 懒加载库：
 *   首条日志写入时才打开，无 IndexedDB 环境首次失败后自动降级停用并 console.warn 一次）
 */
export function startWebAgentWorker(
  scope: WebAgentWorkerScope = self as unknown as WebAgentWorkerScope,
  fetchImpl: typeof fetch = self.fetch,
  onLog: LlmLogFn = () => {},
  logStorage?: LogStorage
): void {
  const handle = createWorkerHandle({
    post: (message: WorkerToMainMessage) => {
      scope.postMessage(message);
    },
    fetchImpl,
    onLog,
    logStorage:
      logStorage ??
      createLazyLogStorage((error) => {
        console.warn('web-agent-worker 调用日志库不可用，已停用落库', error);
      }),
  });
  scope.onmessage = (event: { data: unknown }) => {
    handle.handleMessage(event.data);
  };
  // 脚本求值完成即可收 init（主线程 client 收到 ready 前自行排队缓冲）
  scope.postMessage({ kind: 'ready' } satisfies WorkerToMainMessage);
}
