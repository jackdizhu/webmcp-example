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

## 3. 常用命令

```bash
pnpm build            # 构建所有 package
pnpm --filter <pkg> build   # 构建单个 package
pnpm --filter <pkg> dev     # 开发模式（长驻命令，需先确认）
pnpm typecheck        # 全量类型检查
pnpm lint             # 代码检查
pnpm test             # 运行测试
```

`<pkg>` 取 `chrome-extension` 或 `html-app`。

## 4. html-app 运行验证

1. 进入包目录：`cd packages/html-app`，确认正确安装了 polyfill 依赖。
2. 启动开发服务器暴露页面，页面内 `registerTool()` 已注册工具。
3. 打开浏览器访问页面，在控制台执行：

```js
await document.modelContext.getTools();
```

应能看到工具列表。

## 5. chrome-extension 运行验证

1. 构建插件包：`pnpm --filter chrome-extension build`，得到 `dist/` 产物。
2. Chrome `chrome://extensions` 开启"开发者模式" → 加载已解压的扩展程序，选择 `packages/chrome-extension/dist`。
3. 打开 `html-app` 页面，插件面板应能发现并执行其暴露的工具。

## 6. 常见问题

| 问题 | 排查 |
| ---- | ---- |
| `document.modelContext` 为 `undefined` | 未初始化 polyfill，或浏览器不支持；先执行 polyfill 初始化 |
| 插件无法发现工具 | 插件未能注入 content script，检查 manifest 中页面匹配规则 |
| pnpm 依赖解析异常 | 删除根 `node_modules` 与 `pnpm-lock.yaml` 后重新 `pnpm install` |