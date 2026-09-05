# 003 - 页面工具清单变化不推送侧栏（listChanged → toolsChanged 通道缺失）

| 项 | 内容 |
|---|---|
| 状态 | ✅ 已解决（2026-09-06） |
| 影响模块 | `packages/chrome-extension` / `core/page-tools-bridge.ts`、`main-extension/content-script.ts`、`main-extension/side-panel/`（panel-client、App） |
| 类型 | 缺陷（协议设计缺口） |
| 严重程度 | 中（工具数显示过期，动态注册/注销的工具侧栏不可见） |

## 现象

页面控制台已确认 `listChanged` 生效：

```
[WebMCP] Page tools updated: ['get_status']
```

但侧栏头部工具数停在 `0 个工具`，工具清单获取失败的提示也不消失。

## 根因（两个缺口叠加）

1. **恢复在线后不重新拉取清单**：侧栏挂载时桥接往往尚未就绪（content script 握手重试最长约 50s），首次 `listTools` 失败后 `toolsCount` 停在 0；重连探活成功后 `onStatusChange` 回调只更新状态灯，从不刷新清单——而探活本身就是在成功拿清单。
2. **桥接协议是纯请求-响应，没有推送通道**：content script 的 `listChanged` 回调只把 `Page tools updated` 打到页面控制台，无法到达侧栏 Port。侧栏仅有的拉取时机是挂载一次、每轮对话发送前、调试页手动拉取，页面动态 `registerTool` / 注销工具时侧栏完全无感。

## 修复方案

1. **桥接广播**（`page-tools-bridge.ts`）：`startPageToolsBridge` 返回值改为句柄 `PageToolsBridgeHandle { stop, notifyToolsChanged }`；`notifyToolsChanged()` 向所有活跃 Port 广播 `{ type: 'toolsChanged' }`（无 id 的单向通知，postMessage try/catch 兜底）。
2. **回调接线**（`content-script.ts`）：模块级保存桥接句柄，`listChanged.onChanged` 回调中调用 `bridge?.notifyToolsChanged()`。
3. **通知分发**（`panel-client.ts`）：`onMessage` 识别无 id 的 `toolsChanged` 通知（区别于请求响应），分发到新增的 `onToolsChange` 订阅。
4. **状态跳变兜底刷新**（`App.ts`）：`onStatusChange` 检测 `false → true` 跳变时立即 `refreshTools()`——救活「页面在侧栏连接前就已注册好工具、之后无新变化不触发推送」的挂载时机；同时订阅 `onToolsChange` 实时同步动态变更。

## 经验与约束

- 请求-响应型桥接协议若要反映「对端状态变化」，必须显式设计单向通知消息（本协议约定：无 `id` 字段即通知）。
- 「恢复在线即刷新」与「变化推送」两者互补、缺一不可：推送覆盖运行期动态变更，跳变刷新覆盖连接建立晚于工具注册的时序问题。
- 初始化动作不要依赖挂载时序——桥接就绪可能远晚于侧栏挂载，任何依赖「就绪后才有效」的一次性动作都需要就绪回调兜底重放。

## 回归验证

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（56 passed，含「toolsChanged 广播到所有活跃 Port」「通知分发触发订阅且不影响挂起请求」用例）全绿。
- 产物级验证（手动）：侧栏打开后数秒内工具数自动更新；页面动态注册新工具时侧栏无需操作实时刷新。
