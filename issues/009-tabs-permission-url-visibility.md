# 009 · 缺 `tabs` 权限导致「无活动标签页」：MV3 中 content_scripts.matches 不授予 URL 可见性

- **状态**：✅ 已解决（2026-09-06）
- **影响**：`packages/webmcp-chrome-extension/shell/manifest.json`、`core/tab-source-manager.ts`

## 现象

`http://localhost:5173/` 页面已打开且注入了 content script，但侧栏显示灰色
「relay 未运行（无活动标签页）」；同页面的 `https://webmcp-checker.com/` 也是同样表现。
扩展扫描标签页时仿佛「看不见」任何 URL。

## 根因

**MV3 权限隔离的关键误解**：manifest 中 `content_scripts.matches` 只决定脚本注入，
**不授予** tabs API 的 URL 可见性。没有 `tabs` 权限时：

- `tab.url` / `tab.title` 为 `undefined`；
- `tabs.query({ url: ... })` 的 url 过滤**静默匹配不到任何标签页**（不报错）。

因此 `tab-source-manager` 的 rescan 拿到 tab 列表却读不出 URL，
「无活动标签页」其实是有 tab、无 URL 可见性。

## 修复

1. `shell/manifest.json` 的 `permissions` 增加 `"tabs"`：

```json
"permissions": ["sidePanel", "storage", "downloads", "tabs", "scripting"]
```

2. `core/tab-source-manager.ts` 增加诊断日志
   （`[webmcp-relay-source][diag]` 前缀）：rescan 结果、每个 tab 的 URL 可见性、
   `tabs.onUpdated` complete 事件——让「URL 是否可见」在控制台直接可判。
3. 用 `safeChromeLastError()`（try/catch 包裹）安全读取错误，兼容 jsdom 测试环境
   （无 `chrome` 全局）。

## 验证注意

- 新增权限后必须 `chrome://extensions` **重载扩展**，Chrome 会要求重新确认权限。
- 验证方法：SW console 里跑 `chrome.tabs.query({}, ts => console.log(ts.map(t => t.url)))`，
  能打印 URL 即权限生效。

## 经验

1. **MV3 中 `host_permissions`、`content_scripts.matches`、`tabs` 三者职责独立**：
   注入 ≠ 可见 ≠ 可查询。涉及 `tab.url` / `tabs.query({url})` 的功能，
   manifest 必须显式声明 `tabs`（或 `activeTab` + 用户手势）。
2. 权限类问题往往表现为「静默空结果」而非报错，诊断日志应把
   「预期输入（URL）实际为 undefined」这类信号显式打出来。
