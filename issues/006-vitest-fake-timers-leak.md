# 006 · vitest fake timers 跨用例泄漏：isMockFunction(setTimeout) 判别失效

- **状态**：✅ 已解决（2026-09-06）
- **影响**：`core/relay-source-client.test.ts`（测试基础设施；任何使用 `vi.useFakeTimers` 的测试文件同构风险）

## 现象

同一测试文件内，用例单独运行（`vitest run -t`）通过、全量运行必超时（`Test timed out in 5000ms`），
失败的是**排在 fake timers 用例之后**的普通异步用例（依赖 `setTimeout(0)` 的微任务/宏任务时序
辅助函数 `flushAsync()` 永不 resolve）。

## 根因

文件级 afterEach 曾用如下方式恢复真实定时器：

```ts
afterEach(() => {
  vi.restoreAllMocks();
  if (vi.isMockFunction(setTimeout)) {
    vi.useRealTimers();
  }
});
```

vitest 5 的 fake timers 基于 **@sinonjs/fake-timers**：`vi.useFakeTimers()` 替换的全局
`setTimeout` 是 sinon 生成的函数，**不带 vitest mock 标记**，`vi.isMockFunction(setTimeout)`
恒为 `false` → `vi.useRealTimers()` 从未执行 → fake timers 泄漏到同文件所有后续用例。
`vi.restoreAllMocks()` 不还原定时器环境，兜不住这个洞。

用 `vi.isFakeTimers()` 探针实测确认：排在 fake timers 用例之后的用例中 `vi.isFakeTimers() === true`。

## 修复

```ts
afterEach(() => {
  FakeSocket.reset();
  vi.restoreAllMocks();
  // vitest 5 fake timers 基于 sinon，isMockFunction(setTimeout) 恒 false，不可用作判别
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});
```

## 经验

1. **用例单独跑过、全量跑挂 → 首查跨用例全局状态泄漏**（fake timers、模块级单例、
   全局 stub 未还原）。`vi.isFakeTimers()` 是判别定时器泄漏的直接探针。
2. fake timers 泄漏的典型症状：后续用例卡死在 `setTimeout`/`setInterval` 依赖的辅助
   函数上（本项目即 `flushAsync()`），而 `Promise`/微任务不受影响，症状具有迷惑性。
3. `vi.restoreAllMocks()` 与定时器环境无关；还原 fake timers 只能用 `vi.useRealTimers()`。
