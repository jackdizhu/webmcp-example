# packages/chrome-extension

浏览器插件端。属于 **agent 能力层**，用于调用 WebMCP、验证与执行 tools 等场景。

## 职责

| 能力 | 说明 |
| ---- | ---- |
| 发现 | 读取目标页面 `document.modelContext.getTools()` 暴露的工具 |
| 校验 | 依据工具 `inputSchema` 校验代理传入参数 |
| 执行 | 通过 `executeTool(tool, inputJson)` 或 MCP Client 调用页面工具 |
| 验证 | 获取执行结果并与预期比对，形成验证闭环 |

## 关键约束

- 插件特权 API、密钥仅保留在隔离世界，不在 main world 暴露。
- 避免耦合 `html-app` 页面内部实现细节，只依赖其暴露的 WebMCP 工具接口。

## 参考

- `git-source/webmcp-tools/model-context-tool-inspector`：WebMCP 工具检查器（发现 / schema 可视化 / 连接调试）。
- 架构细节：[docs/architecture.md](../../docs/architecture.md)。
- AI 工作指引：[AGENT.md](../../AGENT.md)。

## 命令

```bash
pnpm --filter chrome-extension build   # 构建产物到 dist/
```