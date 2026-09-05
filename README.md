# webmcp-example

基于 [WebMCP](https://webmachinelearning.github.io/webmcp/)（Web Model Context Protocol，W3C 草案）的示例工程。

通过 `pnpm` 构建 TypeScript 单一仓库（monorepo），包含两个核心模块：

| 模块 | 类型 | 角色 |
| ---- | ---- | ---- |
| `packages/chrome-extension` | 浏览器插件端 | **agent 能力层**：发现、校验、执行、验证页面暴露的 WebMCP tools |
| `packages/html-app` | Web 应用（SPA） | **工具提供层**：通过 `document.modelContext.registerTool()` 暴露结构化工具 |

## 快速开始

```bash
pnpm install        # 安装依赖
pnpm build          # 构建所有 package
pnpm --filter <pkg> build   # 构建单个 package（chrome-extension / html-app）
```

## 文档

- [docs/ 技术文档](docs/README.md)：架构、快速开始、WebMCP 概念参考。
- [rules/ 工程规则](rules/README.md)：语言与项目规范。
- [AGENT.md](AGENT.md)：AI 代理工作指引。

## 上游参考（git 子模块，只读）

- `git-source/webmcp-tools`：GoogleChromeLabs 的 WebMCP 工具集合。
- `git-source/npm-packages`：WebMCP-org 的 `@mcp-b/*` npm 包与文档。

## 许可

MIT