# 环境准备与快速开始

本文说明如何在本机编译、运行 `webmcp-example`。

> 注意：项目为 TypeScript + pnpm 工作区。执行长驻命令（如 `dev`）前请按规则先与用户确认。

## 1. 环境要求

| 工具 | 版本要求                    | 说明                       |
| ---- | --------------------------- | -------------------------- |
| Node.js | ≥ 20（推荐 ≥ 22）        | 运行时                     |
| pnpm  | ≥ 10                        | 包管理（monorepo）         |
| Chrome | 最新稳定版（插件调试用）   | 原生 WebMCP 需实验特性开关 |

检查版本：

```bash
node -v
pnpm -v
```

启用原生 WebMCP（可选）：

```bash
# 使用实验性 Web 平台特性，打开 chrome://flags 搜索
# "Experimental Web Platform features" 并启用
google-chrome --enable-experimental-web-platform-features
```

## 2. 初始化

```bash
# 在仓库根目录
pnpm install
```

这会按 `pnpm-workspace.yaml` 安装 `packages/*` 全部依赖。

> **依赖来源**：`@mcp-b/*`（`webmcp-polyfill`、`transports`、`global`、`webmcp-types`）、
> `@modelcontextprotocol/client`、`vite-plus`、`vite`/`vitest` 等均从 **npm registry** 拉取；
> `git-source/npm-packages` 子模块仅作只读参考，不参与构建。首次安装需要联网。
> 若本机 pnpm 不可用，可先 `npm install -g pnpm@10`（要求 pnpm ≥ 10）。

端到端测试额外需要浏览器（可选）：

```bash
pnpm exec playwright install
```

## 3. 常用命令

```bash
pnpm dev                     # 并行启动所有包的开发模式（长驻命令，需先确认）
pnpm dev:app                 # 仅启动 html-app 开发服务器
pnpm dev:ext                 # 仅启动 chrome-extension watch 构建
pnpm build                   # 构建所有 package
pnpm --filter <pkg> build    # 构建单个 package
pnpm --filter chrome-extension build:e2e   # 构建 e2e 扩展产物
pnpm typecheck               # 全量类型检查
pnpm lint                    # 代码检查
pnpm format                  # 代码检查并自动修复
pnpm test                    # 运行单元测试（仅 src 纯逻辑）
pnpm --filter chrome-extension test:e2e     # 端到端测试（需 Chrome 浏览器）
pnpm clean                   # 清理构建产物
pnpm changeset               # 创建变更记录
```

`<pkg>` 取 `chrome-extension` 或 `html-app`（内部包名分别为
`@mcp-b/webmcp-extension`、`@mcp-b/example-vanilla`，`--filter` 两者皆可）。

> **`dev` 在两包中的语义不同**：`html-app` 启动 Vite 开发服务器（默认 `http://localhost:5173`）；
> `chrome-extension` 是浏览器扩展、没有页面入口，其 `dev` 为 `vp pack --watch`，
> 持续重建 `dist/` 供 Chrome 加载。调试扩展时用 `pnpm dev:ext` 保持构建，
> 再到 `chrome://extensions` 点击刷新即可，无需反复手动 build。

提交前建议通过：`pnpm typecheck && pnpm lint && pnpm test`，最后再执行 `pnpm build` 确认产物。

## 4. html-app 运行验证

1. 进入包目录：`cd packages/html-app`，确认正确安装了 polyfill 依赖。
2. 启动开发服务器暴露页面，页面内 `registerTool()` 已注册工具。
3. 打开浏览器访问页面，在控制台执行：

```js
await document.modelContext.getTools();
```

应能看到工具列表。

## 5. chrome-extension 运行验证

1. 构建扩展：`pnpm --filter chrome-extension build`（开发调试改用 `pnpm dev:ext` 持续 rebuild），
   得到 `packages/chrome-extension/dist/`，内含 `manifest.json`、`main-world.iife.js`、
   `content-script.iife.js` —— 这就是一个可直接加载的 MV3 扩展。
2. Chrome `chrome://extensions` 开启"开发者模式" → "加载已解压的扩展程序"，选择
   `packages/chrome-extension/dist`。改完源码后在扩展卡片点击"刷新"。
3. 打开 `html-app` 页面（`pnpm dev:app`，默认 `http://localhost:5173`），
   DevTools 控制台应打印 `[WebMCP] Page tools: [...]`。

端到端测试加载的是另一份产物 `e2e-extension/dist/` —— 外壳与主扩展相同，
content script 换成测试驱动版，由 Playwright 自动断言：

```bash
pnpm exec playwright install                  # 首次需要下载浏览器
pnpm --filter chrome-extension test:e2e
```

> 两组构建共用 `shell/` 下的 `manifest.json` 与 `main-world.ts`，
> 差异只在隔离世界的 content script，详见
> [chrome-extension README](../packages/chrome-extension/README.md)。

## 6. 常见问题

| 问题 | 排查 |
| ---- | ---- |
| `document.modelContext` 为 `undefined` | 未初始化 polyfill，或浏览器不支持；先执行 polyfill 初始化 |
| 插件无法发现工具 | 插件未能注入 content script，检查 manifest 中页面匹配规则 |
| pnpm 依赖解析异常 | 删除根 `node_modules` 与 `pnpm-lock.yaml` 后重新 `pnpm install` |