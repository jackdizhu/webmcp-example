# 011 · `webmcp_list_sources` 看不见已连接标签页：0 工具源被过滤 + 工具快照推送链无对账

- **状态**：✅ 已解决并实机验证（2026-09-06，用户确认连接正确）
- **影响**：`webmcp-extension-relay/src/registry.ts`、`bridgeServer.ts`、
  `webmcp-chrome-extension/core/relay-source-client.ts`

## 现象

浏览器扩展侧栏显示「relay 已连接 · 1 个标签页 · 0 个工具」，但 MCP 端
`webmcp_list_sources` 返回 `{"count": 0, "sources": []}`、`webmcp_list_tools` 返回 0 工具
——「已连接但没工具」与「什么都没连」在 MCP 侧不可区分，排障被误导。

## 根因

1. **注册表过滤**：`registry.listSources()` 内置
   `.filter((source) => source.toolCount > 0)`——源在 `hello` 握手时即注册，
   但页面推送的工具清单为空时 `toolCount=0`，直接被隐藏。
   注意 `webmcp_list_sources` 的 `count` 取自同一过滤后数组（`count ≡ sources.length`），
   server 模式下不可能出现 `{"count":1,"sources":[]}` 组合；见到该组合应怀疑
   转述失真或连接了旧版 relay 进程。
2. **快照推送无对账**：工具清单同步只有两个触发点——连接建立时的初始快照 +
   存活期 `toolsChanged` 推送链（页面 listChanged → content script → Port → facade →
   `tools/changed`）。任何一环丢失（Port 抖动、页面晚注册工具且 listChanged 未达），
   registry 停留旧快照直到重连，无周期性补偿。

## 修复

| 项 | 位置 | 内容 |
|---|---|---|
| C | `registry.ts` | `listSources()` 保留 0 工具源（带 `toolCount: 0`），并新增 `toolCountOf(connectionId)`；更新原「过滤」测试为「保留 + toolCount 0」断言 |
| D | `bridgeServer.ts` | `tools/list`/`tools/changed` 处理后数量变化时向 stderr 打 `source <id> tools N→M` 对账日志（与扩展端 `[webmcp-relay-source]` 日志两端对账） |
| A | `relay-source-client.ts` | `hello/accepted` 后按 2s/5s/10s 有限次延迟重推工具快照（`INITIAL_RESYNC_DELAYS_MS`），覆盖页面晚注册工具场景 |
| B | `relay-source-client.ts` | `pushToolsChanged` 失败后 1.5s 单次重试（`isRetry` 参数防重试风暴），成功/断线时清理定时器 |

## 数据正确性模型（修复后）

- **查询即真相**：`list_sources`/`list_tools` 每次 live read registry 内存 Map，无缓存。
- **全量替换语义**：`registerTools` 整体替换该连接工具集并重建公共名，无僵尸工具。
- **三层补偿**：初始快照 → 有限次延迟重推（A）→ 失败单次重试（B）；registry 与 MCP
  动态工具经 signature 去重同步（16ms debounce），agent 侧最终一致。
- **残余偏差**（预期行为）：schema 编译失败的工具 registry 有而 MCP 无（stderr warn）；
  in-flight invoke 期间工具被移除返回明确错误而非旧数据。

## 验证

- 扩展 97/97（+2：延迟重推序列、推送失败单次重试）、relay 222/222（+1）、双侧 tsc/lint 全绿。
- **实机验证通过（2026-09-06）**：构建重载扩展 + 重启 relay 后，用户确认连接正确——
  `webmcp_list_sources` 如实返回已连接标签页（含 `toolCount` 字段），
  推送链丢事件场景由延迟重推兜底，relay stderr 对账日志与扩展端 `[webmcp-relay-source]`
  日志可两端对齐定位同步断层。

## 遗留跟进

- 页面侧 0 工具的具体根因（页面晚注册工具 / iframe 注入 / 双 WebMCP 运行时冲突）待
  按扩展端新日志逐项排查；A/B 加固已保证该场景下 registry 最迟 ~10s 收敛，不再阻塞链路验证。

## 经验

1. **「过滤不可用项」类设计要三思诊断成本**：隐藏 0 工具源让连接状态在 MCP 层失明，
   排障时反而放大问题。宁可如实暴露（带 `toolCount: 0`）让消费方自行判断。
2. **事件驱动的状态同步必须有补偿路径**：推送链越长（页面 → content script → Port →
   SW → WS）越容易静默丢事件，有限次延迟重推是低成本高收益的兜底。
