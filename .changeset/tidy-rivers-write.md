---
"@mcp-b/webmcp-extension": minor
"webmcp-extension-relay": minor
---

新增 WebMCP 本地中继包与侧边栏多页面支持：

- 新增 webmcp-extension-relay 包：通过 localhost WebSocket 将浏览器 WebMCP 工具桥接给 MCP 客户端，提供 BridgeServer、MCP Relay Server 与 CLI
- webmcp-extension-relay 新增 webmcp_tool_call 通用工具调用接口，支持跨源工具调用
- 侧边栏 TabBar 重构为 4 页面切换（聊天 / 中继 / 调试 / 设置），新增执行锁与终止按钮
- 修复 0 工具源被隐藏与推送链无对账问题，新增调试页面与调试工具
- 插件名称修正为 webmcp-chrome-extension，版本号更新
