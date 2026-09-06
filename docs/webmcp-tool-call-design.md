# webmcp_tool_call · relay MCP 端通用工具调用入口设计

> 状态：✅ 已实施并验证（2026-09-06）· relay 227/227（+5 用例）、tsc/lint 全绿
> 范围：`packages/webmcp-extension-relay`（仅 relay 包，扩展端零改动）

## 1. 背景与动机

现状：页面工具经 `registry` → `syncDynamicTools` 动态注册为 MCP 工具，agent 按名直接调用。
该链路存在三个不可达场景：

| # | 场景 | 依据 |
|---|---|---|
| 1 | **schema 编译失败的工具不可达**：`syncDynamicTools` 编译失败仅 stderr warn 后跳过，registry 有、MCP 无 | `mcpRelayServer.ts:443-451`（已验证） |
| 2 | **MCP 客户端能力差异**：不处理 `tools/list_changed` 通知的 agent 只感知连接时刻的静态工具集 | 推断（SDK 通知机制，未逐一验证客户端） |
| 3 | **调试对账**：需要绕过动态注册层，直接验证 registry → 浏览器 invoke 链路 | 本轮排障实践 |

`webmcp_tool_call` 作为**通用调用入口**补齐以上场景，与 `webmcp_list_sources` /
`webmcp_list_tools` / `webmcp_open_page` 同属 `webmcp_*` 静态管理工具组。

## 2. 接口设计

```jsonc
// 新增静态 MCP 工具（registerStaticTools 内注册，常驻不随 stateChanged 重建）
"webmcp_tool_call": {
  "description": "Call a relayed WebMCP page tool by its public name. Discover names via webmcp_list_tools first.",
  "inputSchema": {
    "toolName":     "string · 必填 · webmcp_list_tools 返回的公共名（多 tab 同名时带 _<tabId> 后缀）",
    "args":         "object · 可选 · 默认 {} · 透传给页面工具的参数",
    "sourceId":     "string · 可选 · 精确 sourceId（=connectionId），无命中时回退匹配 tabId",
    "requestTabId": "string · 可选 · 严格 tabId 匹配（无回退），定向调用时与 sourceId 二选一"
  },
  "annotations": { "readOnlyHint": false }   // 页面工具可能有副作用
}
```

**解析顺序**（复用 `registry.resolveInvocation`，`registry.ts:205`）：
`sourceId` 精确匹配 → 回退 tabId 匹配 → `requestTabId` 严格匹配 → 缺省取最近活跃 provider。

## 3. 实现方案（最小侵入，核心一跳）

```ts
// mcpRelayServer.registerStaticTools() 新增：
async ({ toolName, args, sourceId, requestTabId }) => {
  try {
    return await this.bridge.invokeTool(toolName, args ?? {}, {
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(requestTabId === undefined ? {} : { requestTabId }),
    });
  } catch (err) {
    // 错误格式与动态工具失败路径一致：isError + content text
  }
}
```

- `bridge.invokeTool(toolName, args, options)` 已是公开 API（`bridgeServer.ts:488`），
  server 模式走 `invokeToolLocally`、client 模式自动走 `invokeToolViaRelay` —— **无需新增协议消息**。
- 结果沿用 `normalizeCallToolResult`（`invokeToolLocally` 内部已处理）。
- 转发给浏览器的 `invoke` 携带 `resolved.tool.name`（原始名），扩展端 facade 按原始名调页面 —— 全链路命名已打通。

## 4. 边界与约束

| 项 | 状态 | 说明 |
|---|---|---|
| toolName 接受公共名 | 已验证 | `resolveInvocation` 查 `providersByPublicToolName`；`list_tools` 返回的 name 即公共名 |
| client 模式忽略 sourceId/requestTabId | 已验证 | `invokeTool` client 分支不传 options（`bridgeServer.ts:496-497`）；定向调用需扩展 relay/invoke 协议，列为后续项 |
| `taskSupport='required'` 工具不可调 | 已验证 | 协议 schema 层过滤（`schemas.ts:14`），消息到不了 registry —— 本工具不解锁，保持协议一致 |
| 调用超时 | 已验证 | 沿用 bridge `invokeTimeoutMs`（默认 65s，CLI `--invoke-timeout` 可调） |
| toolName 为空 / args 非对象 | — | inputSchema 层校验拦截，不进 bridge |

## 5. 测试计划

- `mcpRelayServer.test.ts`：
  1. 静态工具存在且 schema 正确（列在 tools 列表）
  2. server 模式端到端：`connectBrowser` 注册工具 → `webmcp_tool_call` 调用成功回传
  3. `toolName` 无匹配源 → isError（"No active browser source provides tool"）
  4. `sourceId` / `requestTabId` 定向解析
  5. client 模式转发（`invokeToolViaRelay` 路径）
- e2e（可选）：`relay-bridge.e2e.test.ts` 增 `callTool('webmcp_tool_call', { toolName: 'extension_echo' })` 闭环。

## 6. 非目标

- 不解锁 `taskSupport='required'` 工具（协议级约束不动）
- 不替代动态工具注册（正常路径仍按名直调；本工具是兜底入口 + 调试入口）
- client 模式定向调用（relay/invoke 协议扩展 sourceId 透传）留待后续版本
