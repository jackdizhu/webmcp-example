# git-source

本目录存放 `webmcp-example` 引用的 **git 子模块**，作为上游参考源代码，**不作为运行时依赖**。项目运行时依赖见各 `packages/*` 的 `package.json`。

> 参考文档：[docs/webmcp.md](../docs/webmcp.md)（WebMCP 概念与 API）、[AGENT.md](../AGENT.md)（工作指引）。

## 子模块

| 目录 | 上游仓库 | 用途 |
| ---- | -------- | ---- |
| `webmcp-tools` | `github.com/GoogleChromeLabs/webmcp-tools` | GoogleChromeLabs 的 WebMCP 工具集合与示例 |
| `npm-packages` | `github.com/WebMCP-org/npm-packages` | WebMCP-org 的 `@mcp-b/*` npm 包与文档源码 |

### webmcp-tools

- `model-context-tool-inspector/`：Chrome 插件，检查页面是否正确暴露 WebMCP 工具、可视化输入 schema、调试连接问题（`chrome-extension` 的参考实现）。
- `webmcp-evals/`：评估 LLM 工具调用能力的 CLI 工具。
- `webmcp-studio/`：WebMCP 开发集成本地工具。
- `demos/`：各种 WebMCP 示例站点（React、Angular、声明式/命令式等）。
- `AWESOME_WEBMCP.md`：WebMCP 示例与生态精选列表。

### npm-packages

- `packages/`：`@mcp-b/*` 系列包源码（`webmcp-polyfill`、`webmcp-types`、`global`、`webmcp-ts-sdk`、`webmcp-extension`、`webmcp-local-relay` 等）。
- `apps/`、`docs/`、`examples/`、`conformance/`、`e2e/`：应用、文档、示例、一致性测试与端到端测试。
- `AGENTS.md`：面向 AI 代理的上游工作指引（含 WebMCP 架构、包分层、初始化流程）。

## 初始化与更新

子模块声明位于根目录 `.gitmodules`。克隆本仓库后按需初始化：

```bash
# 初始化并检出全部子模块
git submodule update --init --recursive

# 仅检出某个子模块
git submodule update --init git-source/webmcp-tools

# 拉取上游最新（需在子模块目录内执行）
git fetch --all
git checkout main
git pull
```

## 使用约定

- **只读参考**：`git-source/*` 内的内容视为上游源码，严禁修改（见 `rules/project-rules.md` 与 `rules/design_rules.md`）。
- **升级核对**：涉及 WebMCP 行为改动前，先对照 `git-source/npm-packages/AGENTS.md`、WebMCP 草案（`docs/webmcp.md`）与上游源码确认当前 API 形态，再动手。
- **编译耦合**：项目 `packages/*` 若需使用 `@mcp-b/*`，应从 npm 安装正式包，而非直接引用本目录源码。

## 版本历史

| 版本 | 日期 | 变更内容 |
| ---- | ---- | -------- |
| 1.0.0 | 2026-09-05 | 初始版本：说明子模块用途、初始化方式与使用约定 |