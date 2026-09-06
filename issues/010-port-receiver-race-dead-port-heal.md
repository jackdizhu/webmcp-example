# 010 · 重连死循环双 bug：content-script 接收器延迟注册（竞争）+ SW 永不重建死 Port

- **状态**：✅ 已解决（2026-09-06）
- **影响**：`core/page-tools-bridge.ts`、`main-extension/content-script.ts`、
  `core/tab-source-manager.ts`

## 现象

tabs 权限修复后标签页已可见，但状态长期「重连中」。日志两个特征叠加：

- `Unchecked runtime.lastError: Could not establish connection. Receiving end does not exist.`（SW 侧）
- 页面侧：`Hello handshake failed: Attempting to use a disconnected port object`
  （提示「扩展重载后请刷新页面再试」），并伴随大量循环重连日志。

## 根因

两个独立缺陷叠加，且互为掩护：

**① 接收器注册时序竞争**：`content-script.ts` 原实现是
「先 `connectWithRetry()` 完成 MCP 握手（实测 ~55s），**之后**才 `startPageToolsBridge(...)`」。
而 SW 在导航 complete 时立即 `chrome.tabs.connect(tabId)`——此时接收器尚未注册，
Port 必然立即死亡（`Receiving end does not exist`）。

**② SW 永不重建死 Port**：`tab-source-manager` 对已死的 Port 客户端没有任何重建逻辑，
第一次 connect 失败后状态机反复走重连调度，但每次都复用死 Port 对象，
`Attempting to use a disconnected port object` 循环出现——即「重连」永远在重连。

## 修复

**① 同步注册接收器**（`core/page-tools-bridge.ts` + `main-extension/content-script.ts`）：

```ts
// onConnect 接收器在 startPageToolsBridge 内同步注册，
// 请求处理时才 await 真正的 client（可能仍在握手中）
export function startPageToolsBridge(client: Client | Promise<Client>) { ... }

// content-script
const bridge = startPageToolsBridge(connectWithRetry());
```

握手未完成期间到达的连接请求被挂起等待，而非直接失败——彻底消除时序窗口。

**② 死 Port 自愈**（`core/tab-source-manager.ts` 的 `healPort()`）：

- 捕获 `Receiving end` 类错误后，先 `chrome.scripting.executeScript` 重注入
  main-world 桥接 + content-script，再重建客户端（manifest 需 `"scripting"` 权限
  及对应 `host_permissions`）。
- 指数退避 1s → 30s，导航 `complete` 事件重置退避；
  `intentionalDisconnect` 标记区分主动断开（主动断开不触发自愈）。

依赖变更：`shell/manifest.json` permissions 追加 `"scripting"`，
`host_permissions` 增加 `https://*/*`、`http://localhost/*`、`http://127.0.0.1/*`。

## 验证

- 新增 3 个自愈测试用例：意外断连重建 / 主动断开不自愈 / 导航重置退避
  （`core/tab-source-manager.test.ts`）。
- 全量 95/95 测试绿（`vitest run --fileParallelism=false`，避免 jsdom worker 并行 OOM）。
- 实机验证：扩展重载后**无需手动刷新页面**，自愈路径自动重注入并恢复连接。

## 经验

1. **扩展 ↔ content script 的桥接接收器必须与模块加载同步注册**：
   任何「等初始化完成再注册」的写法都在和 SW 的 tabs.connect 赛跑。
   惰性依赖用 `Client | Promise<Client>` 传递，接收器先行。
2. **长生命周期 SW 必须假设 Port 会死**：content script 失效（扩展重载、导航）
   是常态，重建路径（scripting 重注入 + 退避）是必备自愈能力，而非异常处理。
3. 多 bug 叠加时先钉死一个再验证另一个：本例中①导致②的表现更混乱
   （每条新 Port 都是死 Port），若只修②不修①，重连会风暴式失败。
