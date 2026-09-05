# AGENT.md

AI 代理在本仓库中工作的指引。用于理解项目架构、常用命令、编码规范与开发流程。

## 项目简介

`webmcp-example` 是基于 WebMCP（Web Model Context Protocol，W3C 社区组草案）的示例工程。

它通过 `pnpm` 构建一个 TypeScript 单一代码仓库（monorepo），包含两个核心模块：

- `packages/chrome-extension`：浏览器插件端，属于 **agent 能力层**，用于调用、验证、执行 WebMCP tools 等场景。
- `packages/html-app`：Web 应用单页面端（SPA），用于实现 WebMCP tools 能力（页面向 AI 代理暴露可调用的工具）。

## 常用命令

```bash
pnpm install                 # 安装依赖（一次性）
pnpm build                   # 构建所有 package
pnpm typecheck               # 全量类型检查
pnpm lint                    # 代码检查
pnpm test                    # 运行测试
pnpm --filter <pkg> build    # 构建单个 package
pnpm --filter <pkg> dev      # 开发模式运行单个 package
pnpm changeset               # 为发布创建 changeset
```

`<pkg>` 为 `packages/` 下的包名，例如 `chrome-extension`、`html-app`。

## 目录结构

```
webmcp-example/
├── AGENT.md                 # 本文件：AI 代理工作指引
├── README.md                # 工程总览
├── pnpm-workspace.yaml      # pnpm 工作区配置（packages/*）
├── package.json             # 根工程配置与脚本
├── docs/                    # 技术文档
│   ├── README.md            # 文档导航
│   ├── architecture.md      # 整体架构设计
│   ├── getting-started.md   # 环境准备与快速开始
│   └── webmcp.md            # WebMCP 概念参考
├── rules/                   # 工程规则
│   ├── README.md            # 规则索引（适用范围与优先级）
│   ├── language-rules.md    # 语言与编码规范
│   ├── project-rules.md     # 项目级规则（技术栈/模块职责/服务管理）
│   ├── design_rules.md      # 设计规范（多方案比选/多维评估/确认流程/变更分级）
│   └── issues_rules.md      # 个人信息与敏感信息脱敏规则
└── packages/                # 各模块包（pnpm workspace 成员）
    ├── chrome-extension/    # 浏览器插件端（agent 能力层）
    └── html-app/            # Web 应用单页面端（agent 工具层）
```

## 架构总览

```
┌────────────────────────────────────────────────────────────┐
│                    AI 代理（agent 能力层）                    │
│              packages/chrome-extension                       │
│  发现/注册/执行 tools · 使用 WebMCP inspect · 结果验证        │
└───────────────────────────┬────────────────────────────────┘
                            │ Chrome Extension API / MCP Client
                            ▼
┌────────────────────────────────────────────────────────────┐
│                WebMCP tools（工具层）                         │
│                 packages/html-app                           │
│  document.modelContext.registerTool({ ... }) 暴露结构化工具  │
└────────────────────────────────────────────────────────────┘
```

- `html-app`：调用 `document.modelContext.registerTool()` 注册结构化工具，并配合 `@mcp-b/*` 提供的 polyfill / MCP bridge，让浏览器在无原生支持时也能运行。
- `chrome-extension`：作为 agent 能力层，通过浏览器插件 API 发现页面暴露的工具、校验输入 schema、执行工具并验证执行结果（参考 `git-source/webmcp-tools` 中的 Model Context Tool Inspector）。

细节见 [docs/architecture.md](docs/architecture.md) 与 [docs/webmcp.md](docs/webmcp.md)。

## 关键概念

- `document.modelContext`：当前 WebMCP 草案的标准 API 入口。
  - `registerTool(tool, { signal })`：向 AI 代理注册一个工具。
  - `getTools()`：发现已注册的工具。
  - `executeTool(tool, inputJson)`（Chrome 预览扩展）：执行某个已发现的工具。
- `@mcp-b/*`：`npm-packages` 仓库提供的一组合法 npm 包（`webmcp-polyfill`、`webmcp-types`、`global`、`webmcp-ts-sdk`、`webmcp-local-relay` 等），用于 polyfill 与 MCP bridge。
- 参考上游：
  - [git-source/webmcp-tools](git-source/webmcp-tools)：GoogleChromeLabs 的 WebMCP 工具集合（Inspector、Evals、demos）。
  - [git-source/npm-packages](git-source/npm-packages)：WebMCP-org 的 npm 官方包与文档。

> `git-source/` 为两个 git 子模块，仅作参考，不作为运行时依赖。

## 编码规范

- 语言：TypeScript（`.ts` / `.tsx`）。
- 包管理器：pnpm（勿使用 npm / yarn）。
- 代码注释与文档优先使用中文，标识符使用英文。
- 分层：功能按模块拆分文件，单文件不超过 800 行。
- 提交格式：`<type>(<scope>): <subject>`，scope 可为 `chrome-extension` / `html-app` / `docs` / `rules` / `root` / `*`。

## 工程规范

本工程的自定义规则沉淀在 `rules/` 目录，AI 代理与开发者在开发前必须阅读。规则优先级：**工程级规则（rules/） < 仓库级规则（AGENT.md） < 用户/工作区规则**，冲突时以上位规则为准。按需阅读对应规则，详情以各规则文件为准：

| 规则文件 | 阅读场景 |
|----------|----------|
| [rules/README.md](rules/README.md) | 了解规则列表、适用范围与优先级（总览索引） |
| [rules/language-rules.md](rules/language-rules.md) | 编写任何源代码、文档与注释时：输出语言、编码、命名与注释结构 |
| [rules/project-rules.md](rules/project-rules.md) | 全工程开发前：技术栈、模块职责、服务管理、文件大小、提交规范 |
| [rules/design_rules.md](rules/design_rules.md) | 设计类任务（模块架构、跨层契约、工具 schema、配置 Schema、性能优化等）：多方案比选、确认流程、变更分级 |
| [rules/issues_rules.md](rules/issues_rules.md) | 全部对外输出（对话回复、代码注释、日志、文档、终端输出）：个人信息与敏感信息脱敏 |

## 开发流程

1. 阅读 [docs/getting-started.md](docs/getting-started.md) 完成环境准备。
2. 依赖本地或 `git-source/` 的 WebMCP 包，参考 `docs/webmcp.md` 理解 API。
3. 按任务类型阅读 [工程规范](#工程规范) 表格中对应的规则文件，并遵循其要求进行开发。
4. 提交前通过：`pnpm build && pnpm typecheck && pnpm lint`。