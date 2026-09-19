# web-agent-worker

浏览器页面后台线程（Web Worker）调用远程 Agent 接口的公共库。设计文档：`docs/web-agent-worker-explore.md`。

## 能力

| 能力 | 说明 |
| --- | --- |
| `chat`（Dify 直调） | Worker 线程内 POST Dify `/v1/chat-messages`；远端按 Content-Type 自适应解析（streaming SSE 分帧 / blocking JSON 一次解析）；按调用参数 `format` 组装输出：`'sse'` 逐分片回调（`onChunk`），`'json'` 聚合一次返回 |
| `runAgent`（loop-agent） | Worker 线程内运行 LLM tool-use 循环（openai-compat / anthropic 双协议）；Dify 应用注册为可调用工具（`dify__<id>__chat`）；页面随调用注册**临时回调工具**（定义随 `runAgent` 传入，`execute` 在主线程执行，Worker 经反向协议 `tool-call`/`tool-result` 往返）；返回对话最终响应 `text` + 完整 `transcript` |

并发语义：agent 任务最大并发 3（`AGENT_MAX_CONCURRENCY`），超出立即 `agent-busy` 拒绝；临时工具执行超时 60s（Worker 侧计时）自动 isError 回填并从 LLM 工具清单移除。

## 红线

- 零 chrome.*、零 UI、零 DOM 依赖、零 workspace 包依赖（自包含）；
- `fetchImpl` 依赖注入（worker 线程默认 `self.fetch` 解构裸调用）；
- api-key 只进 `Authorization` 头，绝不落日志/持久化；日志只记 URL/事件/状态/耗时。

## 用法（消费方持有 Worker 入口文件）

```ts
// 1. 消费方源码内新建 worker 入口 src/worker/web-agent-worker-entry.ts：
import { startWebAgentWorker } from 'web-agent-worker/worker';
startWebAgentWorker();

// 2. 主线程：
import { createWebAgentClient } from 'web-agent-worker';
import type { WebAgentWorkerConfig } from 'web-agent-worker';

const worker = new Worker(new URL('./worker/web-agent-worker-entry.ts', import.meta.url), { type: 'module' });
const config: WebAgentWorkerConfig = {
  dify: { endpoint: 'https://host/v1/chat-messages', apiKey: 'app-xxx', user: 'demo' },
  // llm/loop 可选：配置后 runAgent 可用
};
const client = createWebAgentClient({ worker, config });

// Dify 直调（流式）
await client.chat({ query: '你好' }, {
  format: 'sse',
  onChunk: (delta, meta) => console.log(meta.event, delta),
});

// loop-agent + 临时回调工具
await client.runAgent(
  { message: '总结当前页面' },
  {
    tools: [{
      name: 'get_page_title',
      description: '返回当前页面标题',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => document.title,
    }],
    onEvent: (event) => console.log(event.type),
  },
);
```

配置（endpoint / api-key / user / inputs / responseMode / 超时）全部由消费方初始化时传入，库内零配置零环境假设。

## 已知约束

- Worker 内 fetch 遵循页面同源 CORS 规则（无豁免）：Dify / LLM 端点需服务端允许跨域；
- vite dev/build 原生支持 `new Worker(new URL(...), { type: 'module' })`，无需额外构建配置。

## 开发

```bash
pnpm --filter web-agent-worker test        # vitest
pnpm --filter web-agent-worker typecheck   # tsc --noEmit
pnpm --filter web-agent-worker lint        # eslint
```
