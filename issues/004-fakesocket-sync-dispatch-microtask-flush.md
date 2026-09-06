# 004 - FakeSocket 同步派发消息丢失：握手消息间必须冲刷微任务（flushAsync 固化时序）

| 项 | 内容 |
|---|---|
| 状态 | ✅ 已解决（2026-09-06） |
| 影响模块 | `packages/chrome-extension` / `core/relay-source-client.ts` 及其测试 `core/relay-source-client.test.ts` |
| 类型 | 测试陷阱（单测桩与真实事件时序不一致） |
| 严重程度 | 低（仅测试层，不影响运行时代码） |

## 现象

为 relay 浏览器源客户端（`RelaySourceClient`）编写单测时，FakeSocket 在 `receive()` 内**同步派发**消息：

```ts
socket.receive({ type: 'server-hello', ... });   // 探测应答
socket.receive({ type: 'hello/accepted' });      // 握手接受
```

后续断言全部失败：`hello/accepted`、`tools/list` 等消息像是「凭空消失」，客户端始终停在探测阶段；而同样的消息序列在真实 relay 下一切正常。

## 根因

`RelaySourceClient` 的消息监听器**不是在 socket 创建时挂上的**：

1. 探测阶段发出 `webmcp-discovery.v1` 请求后，`activateSocket` 是在**探测 promise 的微任务延续里**才把 `message` 监听器挂到 socket 上（此时 socket 才从「探测 socket」晋升为「活跃 socket」）。
2. FakeSocket 同步派发 = `server-hello` 在当前调用栈内立即触达 listener，控制流尚未返回、微任务尚未执行，监听器还没挂上 → 该消息被丢弃；紧随其后的 `hello/accepted` 同理丢失。
3. 真实 WebSocket 的事件派发永远是**宏任务**（网络事件循环），监听器早在下一个事件到来前就绪，因此生产环境无此问题。

一句话：**桩比真实实现「快」了一个微任务，暴露了实现中「先派发、后挂监听」的时序窗口**。实现本身符合真实事件模型，无需改动；要修的是测试桩的派发时序。

## 修复方案

测试桩保持「收到即入队、异步派发」语义，与真实 WebSocket 对齐：

1. **`flushAsync()` 辅助函数**：`await Promise.resolve()`（必要时叠加 `setTimeout 0`）冲刷微任务队列后再派发下一条消息。
2. **握手消息间插入冲刷**：`server-hello` → `await flushAsync()` → `hello/accepted`，保证 `activateSocket` 的微任务先执行、消息监听器已挂上。
3. 所有用例统一走该时序，杜绝「同步连发两条握手消息」的写法。

## 经验与约束

- **单测桩的同步派发 ≠ 真实事件时序**：凡是被测代码存在「先返回 promise、微任务里再挂监听/再晋升状态」的结构，桩必须以异步派发对齐，否则会误报「消息丢失」类缺陷。
- 判别技巧：断言失败但消息确已 `sent`/`receive` → 先怀疑监听器挂载时机，而不是协议实现。
- 新写 FakeSocket 类测试桩时，默认把「派发」做成异步（或强制调用方 `await flushAsync()`），把真实事件循环的宏任务语义固化进测试约定。
- 此陷阱在移植 `widgetRuntime`（上游 webmcp-local-relay）语义到扩展 SW 客户端时出现，两段式握手（探测 → hello ACK）的时序窗口是通用模式，复用该状态机时同样适用。

## 回归验证

- `pnpm --filter @mcp-b/webmcp-extension typecheck` / `lint` / `test`（77 passed，含 19 个 relay 浏览器源新用例）全绿。
- 用临时调试用例（dbg 日志追踪消息派发顺序）验证：插入微任务冲刷后，`server-hello`/`hello/accepted`/`tools/list` 链路完整触达，随后删除调试用例。
