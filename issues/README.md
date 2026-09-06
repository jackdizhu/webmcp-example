# 问题反馈

问题反馈渠道：[Issue](https://github.com/<owner>/webmcp-example/issues)

## Issue 模板

模板统一存放于仓库根目录 `.github/ISSUE_TEMPLATE/`（GitHub 新建 Issue 时自动应用），本目录不再保存模板副本：

| 文件 | 用途 |
|---|---|
| `bug_report.md` | 缺陷报告（标签：bug） |
| `feature_request.md` | 功能建议（标签：enhancement） |
| `question.md` | 问题咨询（标签：question） |
| `config.yml` | 模板选择器配置（禁止空白 Issue） |

> 维护提示：模板修改请直接编辑 `.github/ISSUE_TEMPLATE/` 下对应文件。

## 本目录说明

本目录用于沉淀已记录/已解决的问题（含根因分析与方案），编号格式：`NNN-简短描述.md`。待处理问题请走 GitHub Issue。

## 已记录的问题

| 文件 | 问题描述 | 状态 |
|---|---|---|
| `001-vue-runtime-template-csp-eval.md` | 侧边栏白屏：Vue 运行时模板编译触发 MV3 CSP EvalError | ✅ 已解决 |
| `002-side-panel-messaging-channel-tabs-connect.md` | 侧边栏连不上页面工具桥接：`runtime.connect` 到不了 content script，须用 `tabs.connect(tabId)` | ✅ 已解决 |
| `003-page-tools-changed-no-push.md` | 页面工具清单变化不推送侧栏（listChanged → toolsChanged 推送通道缺失 + 恢复在线不刷新） | ✅ 已解决 |
| `004-fakesocket-sync-dispatch-microtask-flush.md` | FakeSocket 同步派发丢消息：握手消息间须冲刷微任务（flushAsync 对齐真实 WebSocket 宏任务时序） | ✅ 已解决 |
| `005-relay-reconnect-dead-path-active-endpoint.md` | relay 活跃连接断开后不重连：close 监听先清空 activeEndpoint 致同端点重试守卫恒真（死路径） | ✅ 已解决 |
| `006-vitest-fake-timers-leak.md` | vitest fake timers 跨用例泄漏：isMockFunction(setTimeout) 判别 sinon fake 失效，须用 isFakeTimers() | ✅ 已解决 |
| `007-relay-npx-stale-package-rename.md` | README 指引 `npx @mcp-b/webmcp-local-relay` 拉到改名前旧包，协议标识不匹配握手失败，改用本地构建 | ✅ 已解决 |
| `008-lna-loopback-websocket-blocked.md` | Chrome LNA 静默拦截 SW 的 loopback WebSocket（ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS），实现权限检测 + 侧栏琥珀提示 | ✅ 已解决 |
| `009-tabs-permission-url-visibility.md` | 缺 `tabs` 权限致「无活动标签页」：MV3 中 content_scripts.matches 不授予 URL 可见性，tabs.query({url}) 静默空结果 | ✅ 已解决 |
| `010-port-receiver-race-dead-port-heal.md` | 重连死循环双 bug：content-script 接收器在握手后才注册（时序竞争）+ SW 永不重建死 Port，改为同步注册 + scripting 重注入自愈 | ✅ 已解决 |
| `011-list-sources-hides-zero-tool-sources.md` | `webmcp_list_sources` 看不见已连接 0 工具标签页：registry 过滤 toolCount=0 源 + 推送链无对账；改为保留全量源 + 延迟重推 + 失败重试 + 对账日志 | ✅ 已验证 |