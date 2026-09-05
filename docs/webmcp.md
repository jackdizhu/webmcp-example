# WebMCP 概念与 API 参考

本文解释 WebMCP（Web Model Context Protocol）并给出 `webmcp-example` 用到的关键 API 参考。

## 1. 什么是 WebMCP

WebMCP 是 W3C（Web Machine Learning 社区组）的草案标准。它让**每一个浏览器标签页都能成为"工具源"**：网页通过一个标准 API 注册结构化工具，供 AI 代理发现并调用，从而避免依赖粗糙的页面抓取（site scraping）。

示例：`document.modelContext` 让你注册一个"添加待办"工具，AI 代理就可以通过结构化参数调用它，而不是去解析页面 DOM。

```
document.modelContext
├── .registerTool(tool, { signal })  向 AI 代理注册一个工具
└── .getTools()                      发现页面已注册的工具

Chrome 预览扩展
└── .executeTool(tool, inputJson)    执行已发现的工具
```

## 2. 核心 API

### 2.1 `registerTool(tool, options)`

在每个标签页执行一次，把工具暴露给 AI 代理。

```ts
await document.modelContext.registerTool({
  name: 'add_todo',                                   // 工具名
  description: 'Add a new todo item',                 // 工具描述
  inputSchema: {                                      // input JSON Schema
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
  },
  execute: async (args) => ({ id: Date.now(), title: args.title }), // 执行函数
});
```

- `name`：唯一且可读。
- `description`：描述工具用于何场景，便于代理判断是否调用。
- `inputSchema`：JSON Schema，定义代理可传入的参数。
- `execute`：异步函数，接收代理传入的参数并返回结果。

### 2.2 `getTools()`

发现当前页面注册的全部工具，返回工具元数据列表。

### 2.3 `executeTool(tool, inputJson)`

Chrome 预览扩展 / 兼容实现提供的扩展方法，用于执行某个已发现的工具。

## 3. 原生支持与 polyfill

- **原生支持**：Chrome 开启 `--enable-experimental-web-platform-features` 后即可使用 `document.modelContext`。
- **Polyfill**：在其它浏览器或无原生支持时，使用 `@mcp-b/webmcp-polyfill` 打上 polyfill，代码可保持一致。

```ts
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';

initializeWebMCPPolyfill(); // 若已有原生支持则为 no-op

await document.modelContext.registerTool({ /* ... */ });
```

## 4. `@mcp-b/*` 包体系

`git-source/npm-packages` 提供的合法 npm 包，供本项目按需选用：

| 包 | 用途 |
| -- | ---- |
| `@mcp-b/webmcp-polyfill` | 严格的 WebMCP 核心 polyfill |
| `@mcp-b/webmcp-types` | TypeScript 类型定义 |
| `@mcp-b/global` | 完整运行时：polyfill + MCP bridge（prompts / resources / transport） |
| `@mcp-b/webmcp-ts-sdk` | 浏览器适配的 MCP TypeScript SDK（BrowserMcpServer） |
| `@mcp-b/webmcp-extension` | MV3 插件模板 + 隔离的 content-script client |
| `@mcp-b/webmcp-local-relay` | 将网站工具转发给桌面 AI 代理（Claude Desktop / Cursor 等） |

## 5. 在 `webmcp-example` 中的用法

- `packages/html-app`：作为工具提供方，引入 polyfill（或 `@mcp-b/global`），调用 `registerTool()` 暴露本应用的业务能力。
- `packages/chrome-extension`：作为 agent 能力层，通过浏览器 API / MCP Client 发现 `html-app` 暴露的工具，按 schema 校验输入、执行并验证结果。

## 6. 参考来源

- W3C 草案：<https://webmachinelearning.github.io/webmcp/>
- MCP 规范：<https://modelcontextprotocol.io/>
- 上游仓库：`git-source/webmcp-tools`、`git-source/npm-packages`。

> 草案 API（尤其 `executeTool` 的入参形态：对象 vs 序列化 JSON）仍在演进，实现前务必对照草案与上游源码确认。