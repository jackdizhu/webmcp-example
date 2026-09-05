# `@mcp-b/webmcp-extension`

Chromium 扩展：在页面注入 WebMCP，并从隔离世界（isolated world）发现、调用页面暴露的工具。

属于本工程的 **agent 能力层** —— 页面侧（`html-app`）负责注册工具，本扩展负责发现与调用，
两者只通过 WebMCP 工具接口通信，不互相依赖内部实现。

## 目录结构

| 路径 | 作用 |
| ---- | ---- |
| `shell/` | **共享扩展外壳，两个构建共用**：`manifest.json` 与 MAIN world 入口 `main-world.ts` |
| `core/` | **共享核心逻辑**：`content-script.ts` 导出 `connectWebMCPClient`（agent 能力层） |
| `main-extension/` | 主扩展项目：给人手动加载，content script 打印页面工具列表 |
| `e2e-extension/` | e2e 扩展项目（自包含）：测试驱动的 content script + Playwright 断言 |

### 为什么共享部分要单独抽出来

两个扩展的差异**只在隔离世界的 content script**，而以下部分完全一致，因此抽到独立文件夹：

- `shell/`：manifest 与 main-world 入口。新增一个扩展只需换掉 content script，不必复制外壳。
  `shell/main-world.ts` 只有一行 `import '@mcp-b/global'`，跑在页面 MAIN world，负责把
  WebMCP 运行时装进页面（原生支持用原生，否则降级 polyfill）。
- `core/`：隔离世界的 `connectWebMCPClient` 是两份 content script 的共同依赖，抽到 `core/`
  避免重复实现。

### 为什么分两个目录而不是覆盖同一份

manifest 里声明的文件名是固定的（`main-world.iife.js` / `content-script.iife.js`），而两份
content script 行为不同（一个面向使用、打印工具，一个面向断言、驱动测试），放在同一目录会
互相覆盖。因此主扩展产物在 `dist/`，e2e 扩展产物在 `e2e-extension/dist/`。

## 两个独立扩展构建

| 构建 | 命令 | 产物 | 用途 |
| ---- | ---- | ---- | ---- |
| `main-extension` | `pnpm build` | `dist/` | 手动加载调试，控制台打印页面工具列表 |
| `e2e-extension` | `pnpm build:e2e` | `e2e-extension/dist/` | Playwright 自动加载并断言 |

两个产物结构相同（`manifest.json` + `main-world.iife.js` + `content-script.iife.js`），
都是 IIFE 自包含 classic script —— content script 无法在运行时解析裸导入，依赖必须全部内联。

## 快速开始

```bash
pnpm build                      # 产出可直接加载的扩展 dist/
pnpm --filter html-app dev      # 另开终端，启动示例页面
```

1. 打开 `chrome://extensions`，开启"开发者模式"
2. "加载已解压的扩展程序" → 选择 `packages/chrome-extension/dist`
3. 访问 `http://localhost:5173`，DevTools 控制台应打印 `[WebMCP] Page tools: [...]`

开发时改用 `pnpm dev`（watch），改完源码在扩展卡片点"刷新"即可，无需反复 build。

## 职责

| 能力 | 说明 |
| ---- | ---- |
| 发现 | 读取目标页面 `document.modelContext.getTools()` 暴露的工具 |
| 校验 | 依据工具 `inputSchema` 校验代理传入参数 |
| 执行 | 通过 `executeTool(tool, input)` 或 MCP Client 调用页面工具 |
| 验证 | 获取执行结果并与预期比对，形成验证闭环 |

## 关键约束

- 插件特权 API、密钥仅保留在**隔离世界**。`shell/main-world.ts` 与页面共享 JavaScript
  环境，不得放入敏感逻辑。
- 避免耦合 `html-app` 页面内部实现细节，只依赖其暴露的 WebMCP 工具接口。
- 客户端 transport 把消息固定到 `window.location.origin`，这是路由而非鉴权：
  同源页面代码可以观测或伪造该通道。页面工具的参数与结果一律视为不可信输入。
- 发布前收窄 `shell/manifest.json` 的 match patterns，并补齐图标等商店元数据。
- 该扩展只注入顶层页面。原生 Chrome 仍会通过 `getTools()` 发现同源子文档的工具。

## 测试

```bash
pnpm test        # 单元测试（仅 core 纯逻辑）
pnpm test:e2e    # 端到端（需先 pnpm exec playwright install，并 pnpm build:e2e）
```

e2e 覆盖 document_start 注入、严格页面 CSP、命令式与声明式工具的发现与调用、
`toolautosubmit`、`respondWith()`、工具列表变更、工具错误、动态注册与移除、
顶层框架作用域、导航与 BFCache 恢复，另有一条原生 Chromium 通道验证同源子文档工具。

## 参考

- `git-source/webmcp-tools/model-context-tool-inspector`：WebMCP 工具检查器
  （发现 / schema 可视化 / 连接调试），是本包的参考实现。
- 上游来源：WebMCP-org/npm-packages 的 `webmcp-extension` 包。
- 架构细节：[docs/architecture.md](../../docs/architecture.md)。
- AI 工作指引：[AGENT.md](../../AGENT.md)。
