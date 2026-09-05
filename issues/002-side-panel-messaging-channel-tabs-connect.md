# 002 - 侧边栏连不上页面工具桥接：`runtime.connect` 到不了 content script

| 项 | 内容 |
|---|---|
| 状态 | ✅ 已解决（2026-09-06） |
| 影响模块 | `packages/chrome-extension` / `main-extension/side-panel/`（panel-client）、`core/`（chrome.d.ts） |
| 类型 | 缺陷（Chrome 消息通道 API 选型错误，架构级） |
| 严重程度 | 高（侧边栏核心功能完全不可用） |

## 现象

页面主世界控制台一切正常（MCP 链路通）：

```
[WebMCP] Page tools: ['get_status']
[WebMCP] Page tools updated: ['get_status']
```

但侧边栏始终异常：

```
WebMCP 页面工具助手
0 个工具
工具清单获取失败：与页面工具桥接的连接已断开（Could not establish connection.
Receiving end does not exist.），将自动重连
```

伴随：`bridge_disconnected` 日志按指数退避节奏反复刷屏、`Unchecked runtime.lastError` 告警、连接状态在线/离线抖动。

## 根因（官方文档实锤）

Chrome 官方 messaging 文档（developer.chrome.com/docs/extensions/messaging）明确通道方向：

> - `runtime.connect()` — **content script → 扩展页面**（扩展进程上下文）
> - `tabs.connect(tabId)` — **扩展页面 → content script**

侧边栏属于扩展页面，此前却用 `chrome.runtime.connect({ name: 'webmcp-page-tools' })` 发起连接——该调用只在扩展进程上下文间投递（service worker / 扩展页面），**永远到不了 content script** 的 `runtime.onConnect` 监听端。于是每次 Port 创建即立即 onDisconnect（"Receiving end does not exist"）→ 探活超时 → 无限重连。

**现象链判定**：content script 侧桥接监听一直正常存活（页面日志证明），断点在通道选型。此前的多轮修复（lastError 消费、状态置位时序、指数退避重连、toolsChanged 推送）处理的都是这一个根因的下游症状。

## 排查过程（值得复用的排除法）

| 环节 | 验证方式 | 结论 |
|---|---|---|
| service-worker | 通读代码，无消息逻辑 | 排除 |
| content script ↔ 主世界 | `TabClientTransport` 纯 `window.postMessage`，不触碰 chrome 消息 API | 排除 |
| 桥接监听端 | 只 `onConnect` 监听不发起；页面日志证明存活 | 排除 |
| **侧栏发起端** | `chrome.runtime.connect`；报错只出现在侧栏 Console | **定位** |

## 修复方案

1. **通道改用 `chrome.tabs.connect`**：`panel-client.ts` 默认连接工厂改为「`tabs.query({ active: true, currentWindow: true })` 取活动标签页 → `tabs.connect(tabId, { name: 'webmcp-page-tools' })`」。
2. **端口创建异步化**：`portFactory` 允许返回 `Promise<Port>`，`ensurePort` 异步化并对并发创建去重；`teardownPort` 统一断开清理。
3. **跟随活动标签页**：监听 `tabs.onActivated`，切换标签页时断开旧 Port、重置退避、自动重连新页面的桥接（多标签场景侧栏始终操控当前页面）；`disconnect()` 时移除监听防泄漏。
4. `core/chrome.d.ts` 补 `chrome.tabs`（`query` / `connect` / `onActivated`）最小声明。

## 顺带修复的下游症状（同一轮沉淀）

- **Unchecked runtime.lastError**：`onDisconnect` 监听器内必须同步读取并消费 `chrome.runtime.lastError`，否则 Chrome 追加打印 Unchecked 告警；错误原文并入重连提示。
- **在线状态抖动**：Port 建立成功 ≠ 在线，改为「收到该 Port 首条响应」才置在线。
- **重连策略**：指数退避 1s→15s 封顶，探活（listTools ping，5s 超时）成功重置退避。

## 经验与约束（已沉淀到 `rules/project-rules.md`）

- **扩展页面 ↔ content script 必须用 `chrome.tabs.connect(tabId)`**；`runtime.connect` 仅用于 content script → 扩展页面方向（以及扩展内部上下文之间）。
- Side Panel 属扩展页面，不是 content script，方向极易搞反——**写连接代码前先核对消息通道方向表**。
- 消费 `chrome.runtime.lastError` 是 `onDisconnect` 监听器的义务，不读必报 Unchecked。
- 排障先判「哪一侧的控制台出现报错」，可快速二分定位断点所在上下文。

## 回归验证

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（58 passed，含「默认工厂走 tabs.connect」「切换标签页跟随重连」等新用例）全绿。
- 产物级验证（手动）：重新 build + 重载扩展 + 刷新页面后，侧栏数秒内转在线、工具数正确；切换标签页自动跟随；不再出现 `bridge_disconnected` 刷屏与 Unchecked 告警。
