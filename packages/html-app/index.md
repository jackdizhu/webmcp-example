# packages/html-app

Web 应用单页面端（SPA）。用于实现 WebMCP tools 能力，即页面向 AI 代理暴露可调用的结构化工具。

## 职责

| 能力 | 说明 |
| ---- | ---- |
| 暴露 | 通过 `document.modelContext.registerTool()` 注册业务工具（如表单提交、数据查询） |
| 兼容 | 引入 `@mcp-b/webmcp-polyfill`（或 `@mcp-b/global`），保证无原生支持的浏览器可用 |
| 返回 | 执行函数返回结构化结果，供 agent 能力层（`chrome-extension`）验证 |

## 示例

```ts
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';

initializeWebMCPPolyfill();

await document.modelContext.registerTool({
  name: 'get_page_title',
  description: '返回当前页面标题',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: document.title }] }),
});
```

## 关键约束

- 不混入浏览器插件特权逻辑；main world 中不暴露密钥。
- 不与 `chrome-extension` 内部实现反向耦合，仅作为工具提供方。

## 参考

- API 概念：[docs/webmcp.md](../../docs/webmcp.md)。
- 架构细节：[docs/architecture.md](../../docs/architecture.md)。
- AI 工作指引：[AGENT.md](../../AGENT.md)。

## 命令

```bash
pnpm --filter html-app dev      # 开发模式（长驻命令，需先确认）
pnpm --filter html-app build    # 构建生产产物
```