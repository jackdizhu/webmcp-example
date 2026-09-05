# 整体架构设计

本文说明 `webmcp-example` 的整体架构、模块职责与典型调用流程。

## 1. 架构图

```
┌────────────────────────────────────────────────────────────┐
│                  AI 代理（agent 能力层）                      │
│                  packages/chrome-extension                  │
│   · 通过浏览器 API / MCP Client 与页面通信                    │
│   · 发现工具 → 校验 schema → 执行 → 验证结果                 │
└───────────────────────────┬────────────────────────────────┘
                            │  Extension Runtime / postMessage
                            │  （浏览器插件特权通道）
                            ▼
┌────────────────────────────────────────────────────────────┐
│                WebMCP tools（工具提供层）                    │
│                   packages/html-app                        │
│   · document.modelContext.registerTool()暴露业务工具        │
│   · 引入 @mcp-b polyfill / bridge，兼容无原生支持浏览器       │
└────────────────────────────────────────────────────────────┘
```

## 2. 模块职责

### 2.1 `packages/chrome-extension`（agent 能力层）

浏览器插件端，是 AI 代理能力的落地载体。它负责：

1. **发现**：读取目标页面 `document.modelContext.getTools()` 暴露的工具列表。
2. **校验**：依据工具 `inputSchema` 校验代理传入的参数是否合法。
3. **执行**：通过 `executeTool(tool, inputJson)` 或 MCP Client 调用页面工具。
4. **验证**：获取执行结果，校验返回是否符合预期，作为工具验证闭环。

约束：插件特权 API、密钥等仅保留在插件隔离世界（main world 之外），避免耦合页面实现细节。

参考实现：`git-source/webmcp-tools/model-context-tool-inspector`。

### 2.2 `packages/html-app`（工具提供层）

Web 应用单页面端（SPA），作为工具提供方。它负责：

1. 通过 `document.modelContext.registerTool()` 暴露本应用的业务能力（如表单提交、数据查询）。
2. 引入 `@mcp-b/webmcp-polyfill`（或 `@mcp-b/global`），保证在无原生支持的浏览器中同样可用。

约束：不混入浏览器插件特权逻辑；main world 中不暴露密钥。

## 3. 依赖关系

单向依赖，保持清晰边界：

```
chrome-extension  ──调用──►  html-app（暴露的 WebMCP tools）
html-app  ──不依赖──►  chrome-extension 内部实现
```

两者共同：可选依赖 `@mcp-b/*`（来自 `git-source/npm-packages`）。

## 4. 典型调用流程

1. 用户打开 `html-app` 页面，页面完成 polyfill 初始化并 `registerTool()` 注册若干工具。
2. 用户加载 `chrome-extension`，插件读取当前页面工具列表（发现）。
3. AI 代理收到用户意图后，选择合适工具，按 `inputSchema` 组参。
4. 插件调用 `executeTool` / MCP Client 执行工具（执行）。
5. 插件读取执行返回并与预期比对，输出验证结论（验证）。

## 5. pnpm 工作区

根目录配置 `pnpm-workspace.yaml`，成员为 `packages/*`：

```
packages/
├── chrome-extension/
└── html-app/
```

### 5.1 依赖来源与版本管理

| 依赖类别 | 来源 | 说明 |
| -------- | ---- | ---- |
| `@mcp-b/*`（`webmcp-polyfill`、`transports`、`global`、`webmcp-types`） | **npm registry** | 按项目规则「优先复用上游包」，直接消费已发布的正式包 |
| `@modelcontextprotocol/client` | npm registry | MCP 客户端 SDK |
| `vite-plus` | npm registry（固定 `0.1.24`） | `chrome-extension` 的构建工具，提供 `vp pack` 与 `vite-plus/pack` |
| `vite` / `vitest` | npm registry | `html-app` 构建与单元测试 |
| `eslint` / `typescript` | npm registry | 根工程统一的校验工具链 |

要点：

- 两个包均**不使用 `workspace:*`** 指向 `git-source/npm-packages`——子模块是只读参考，按规则不作运行时依赖。
- 共享版本统一在 `pnpm-workspace.yaml` 的 `catalog` 中声明，包内用 `catalog:` 引用，避免版本漂移。
- `chrome-extension` 保留 `vite-plus` 构建（与上游一致），`html-app` 使用标准 `vite`，两者互不冲突。

### 5.2 验证体系

根目录统一暴露命令，逐级校验：

| 命令 | 作用 | 覆盖范围 |
| ---- | ---- | -------- |
| `pnpm build` | 构建全部包 | `vp pack`（插件产物 + d.ts）、`tsc && vite build`（SPA 产物） |
| `pnpm typecheck` | 全量类型检查 | 各包 `tsc --noEmit`；插件侧含 `src` / `e2e` / `template` / `vite.config.ts` |
| `pnpm lint` | 代码检查 | 根扁平配置 `eslint.config.mjs`，覆盖全部 `.ts` / `.mjs` |
| `pnpm test` | 单元测试 | `vitest run`，仅覆盖纯逻辑（目录 `src`） |
| `pnpm --filter chrome-extension test:e2e` | 端到端测试 | node test runner + Playwright，需已构建扩展与浏览器 |

设计约束：

- 单元测试只跑 `src` 下的纯逻辑；`e2e` 依赖真实 Chrome 与已构建扩展，通过 `vitest.config.ts` 的 `include` 排除在默认测试之外，避免 `pnpm test` 被重资源用例拖垮。
- `lint` 统一使用 ESLint（而非 `vp lint`），保证两个包规则一致。

常用命令见 [getting-started.md](getting-started.md)，AI 工作指引见 [AGENT.md](../AGENT.md)。