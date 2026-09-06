# 005 · 活跃连接断开后重连死路径：close 监听先清空 activeEndpoint

- **状态**：✅ 已解决（2026-09-06）
- **影响**：`core/relay-source-client.ts`（relay 浏览器源客户端）

## 现象

为 relay 客户端新增「连接状态回调」编写测试时发现：对一条**已建立**的连接模拟 relay 侧断开
（`socket.close()` → close 事件）后，客户端永远停留在旧状态，状态机不进入 `reconnecting`，
同端点重试路径从未执行。真实环境下表现为：relay 进程重启后，已连接的标签页**不会自动重连**，
MCP 客户端看到该 tab 源永久消失（直到页面刷新或 SW 重启）。

## 根因

close 监听器与重试调度对同一字段的读写顺序矛盾：

```ts
socket.addEventListener('close', () => {
  if (this.activeSocket !== socket || this.stopped) return;
  this.activeSocket = null;
  this.activeEndpoint = null;          // ← 先清空
  this.scheduleRetrySameEndpoint();    // ← 内部检查 !this.activeEndpoint → 直接 return
});
```

`scheduleRetrySameEndpoint` 的守卫条件 `!this.activeEndpoint` 在调用点**恒为 true**，
同端点重试分支成为死代码。由于既有测试只覆盖「从未连接成功 → 全范围重扫」路径，
从未覆盖「活跃连接被断开 → 同端点重试」，该缺陷在测试全绿的情况下长期潜伏。

## 修复

close 监听器先留档端点拷贝，再以参数形式传入重试调度：

```ts
const lastEndpoint = this.activeEndpoint ? { ...this.activeEndpoint } : null;
this.activeSocket = null;
this.activeEndpoint = null;
this.helloAccepted = false;
this.scheduleRetrySameEndpoint(lastEndpoint);   // 签名改为显式入参
```

## 经验

1. **「状态机守卫条件 + 调用点清理同一状态」是死路径高发区**：重构时先画出每个守卫分支
   的触发时序，确认存在至少一条可达路径。
2. 测试覆盖「成功后的失败路径」（断开/拒绝/超时）与「失败路径」同样重要——全部测试通过
   ≠ 全部代码路径可达。新增状态回调时顺带的迁移断言就暴露了此 bug。
