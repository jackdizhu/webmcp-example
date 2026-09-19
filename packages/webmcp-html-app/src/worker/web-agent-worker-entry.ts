// Web Agent Worker 入口（消费方持有的 new Worker 目标文件，设计 §4.1-1）。
// `new URL('./worker/web-agent-worker-entry.ts', import.meta.url)` 的相对路径
// 必须相对本文件，因此入口由消费方持有；库只导出 startWebAgentWorker。
import { startWebAgentWorker } from 'web-agent-worker/worker';

startWebAgentWorker();
