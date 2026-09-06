# 设计方案：webmcp-local-relay 移植包去 embed 化改造（对接 chrome-extension 浏览器源）

| 项 | 内容 |
|---|---|
| 状态 | ✅ P1 已执行（2026-09-06，默认值选定方案 A）；✅ P0 已执行（2026-09-06，含包改名 webmcp-extension-relay 与协议标识协同更新）；✅ P2 已编写（e2e 待真实浏览器运行） |
| 对象 | `packages/webmcp-extension-relay`（整体移植自 `git-source/npm-packages` 上游 v5.1.0，MIT） |
| 对接方 | `packages/chrome-extension`（已实现 `core/relay-source-client.ts` 浏览器源客户端，typecheck/lint/test 全绿） |
| 目标 | 移除 embed iframe 分发面，使扩展成为唯一浏览器客户端；协议核心零改动对接 |

## 1. 现状与问题

移植包目前是上游的**完整拷贝**，包含三条互斥的浏览器接入路线：

| 路线 | 载体 | 状态 |
|---|---|---|
| embed iframe（上游主路线） | `src/browser/`（embed.ts / widget.ts / widgetRuntime.ts / shared.ts）+ `dist/browser/embed.js` + `widget.html` 构建 | **要移除**：页面端侵入（注入脚本 + 隐藏 iframe），与用户「零页面侵入」决策冲突 |
| Chrome 扩展浏览器源 | `packages/chrome-extension` SW 直连 WS（webmcp.v1 协议） | **已实现**，是对接目标 |
| 内部 relay-client 协议 | `webmcp-relay.v1`（多 relay 实例级联） | 保留，不动 |

同时移植包还带着上游的发布链路（MCPB 打包、npm publishConfig、浏览器 IIFE 构建），在本仓库均无意义。

**关键前提（已验证）**：relay 服务端只认「WebSocket + 子协议 + hello/tools 消息」，不关心对端是 iframe 还是扩展。扩展端 `relay-source-client.ts` 已按上游 `schemas.ts` 手写对齐协议（探测 → server-hello → hello → hello/accepted → tools/list → invoke/result），**协议核心零改动即可对接**。

## 2. 改造边界

### 2.1 删除清单（P0）

| 删除项 | 理由 |
|---|---|
| `src/browser/` 整个目录（4 源文件 + 2 测试） | embed iframe 路线整体退役 |
| `scripts/build-widget-html.js`、`scripts/build-mcpb.sh`、`manifest.json` | widget.html 构建 + MCPB（Claude Desktop 双击安装）打包，随 embed 退役 |
| `vite.config.ts` 的 `embedConfig` / `widgetConfig` 两个 browser pack 组 + `browserBase` | 只留 `nodeConfig`（`src/index.ts` + `src/cli.ts`，ESM + dts） |
| `tsconfig.browser.json`；`typecheck` 脚本去掉 `tsc -p tsconfig.browser.json` | 浏览器构建面消失 |
| `vitest.e2e.config.ts` + `src/relay.e2e.test.ts` | e2e 依赖 `dist/browser/embed.js` / `widget.html`，随之失效（P2 用扩展 e2e 替代） |
| devDeps：`@anthropic-ai/mcpb`、`@mcp-b/webmcp-polyfill`、`@mcp-b/global`、`playwright` | 全部只服务于 embed 构建 / MCPB / 旧 e2e |

### 2.2 保留不动（协议核心，对接兼容面）

`bridgeServer.ts` / `registry.ts` / `naming.ts` / `schemas.ts` / `protocol.ts` / `portStrategy.ts` / `cli.ts` / `cli-utils.ts` / `mcpRelayServer.ts` 及其 6 个测试文件。理由：

- 扩展端已按这套 schema 实现并通过 19 个单测，改动协议任何字段都会破坏对接
- `webmcp-discovery.v1` 子协议保留：扩展端口发现（hint → 缓存 → 9333–9348 扫描）依赖它
- `webmcp_open_page` 保留：其 `refresh` 语义与扩展的 `reload` 自愈回调天然配合

### 2.3 package.json 收敛（P0）

- `description` / `keywords`：去掉 iframe / embed 表述
- `publishConfig` 删除（不发布 npm）；`files` 保留 `dist`
- scripts 对齐本仓库 chrome-extension 风格（上游 `vp test/vp lint` → `vitest run` / `eslint .`）：
  ```jsonc
  {
    "build": "rm -rf dist && vp pack",
    "lint": "eslint .",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  }
  ```

### 2.4 工作区 catalog 补齐（P0）

移植包依赖在根 `pnpm-workspace.yaml` catalog 中缺失三项，按上游锚点补齐：

```yaml
'@modelcontextprotocol/core': 2.0.0
'@modelcontextprotocol/server': 2.0.0
zod: 4.4.3
```

`ws ^8.21.3` / `@types/ws ^8.5.14` 为直接版本，保留在包内（上游亦如此）。

## 3. 对接增强（P1，推荐）

### 3.1 Origin 校验收紧 —— embed 移除后的安全模型升级（✅ 已执行，2026-09-06）

已实施（方案 A：默认 `chrome-extension://*`）：

1. `bridgeServer.ts` 的 `isHostOriginAllowed` 支持通配 scheme 匹配：任意 `<scheme>://*` 形式的 allowlist 项按 scheme 前缀放行（`chrome-extension://*` 覆盖 unpacked 随机 id）
2. **默认值收紧**：`bridgeServer` options 与 `parseCliOptions` 的默认 allowedOrigins 均从 `['*']` 改为 `['chrome-extension://*']`；网页 origin（https://）默认被拒（`hello/rejected: host-origin-not-allowed`），真有网页直连需求时显式 `--widget-origin` 追加
3. `printHelp` 文案同步（usage 示例、`--widget-origin` 说明通配语义）
4. 测试：新增 2 个用例（通配放行 chrome-extension origin；默认策略拒绝 https origin）+ 更新 cli 默认值断言；relay 包 269 passed

扩展侧无需任何改动（`relay-source-client` 已实现 `hello/rejected: host-origin-not-allowed` 处理与重试状态机）。

### 3.2 文档同步

- 包 README：重写「浏览器接入」章节为「Chrome 扩展作为浏览器源」，删除 embed 接入指南；保留 MIT 许可原文与原作者署名，注明本 fork 修改点
- 根 `README.md` / `docs/extension-relay-reuse-design.md`：交叉引用更新（设计文档标注「已按本方案收敛」）
- 归属说明：保留上游 `author` 字段或改仓库统一格式，`CHANGELOG.md` 保留上游历史

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 删除旧 e2e 后失去端到端覆盖 | P2：`chrome-extension/e2e-extension` 增加 relay 集成用例（真实 SW WebSocket ↔ relay ↔ MCP client），复用现有 e2e 基建 |
| 上游同步成本 | 修改集中在构建/分发面（package.json / vite.config / 目录删除），`src/` 协议核心仅 P1 的 `isHostOriginAllowed` 一处小改 → 后续 diff upstream 仍可读 |
| catalog 补 zod 4.4.3 与其他包潜在冲突 | 当前工作区无其他包依赖 zod，无冲突面；后续如引入需重新对齐 |
| 误删 relay-client 级联协议 | 明确保留清单（§2.2），删除只动 `src/browser/` 与构建脚本 |

## 5. 实施步骤

1. **P0 去 embed 化**：按 §2.1 删除 → §2.3 package.json 收敛 → §2.4 catalog 补齐 → `pnpm --filter webmcp-extension-relay typecheck/lint/test` 全绿 → README 同步
2. **P1 对接增强**（✅ 已执行，见 §3.1）
3. **P2 e2e 集成**（✅ 代码已落地，2026-09-06）：`webmcp-chrome-extension/e2e-extension/relay-bridge.e2e.test.ts`
   + `pnpm test:e2e:relay` 脚本。验证闭环：真实 Chrome 加载 e2e 扩展 → SW 端口发现连接 relay
   （单进程、stdio+WS 双传输）→ MCP 客户端看到 `webmcp_list_sources`/页面工具 → `callTool`
   全链路调用与错误传播。构建命令按仓库约束由用户手动执行；relay 产物缺失时测试自动跳过。

## 6. P1 执行期间的前置调整（安装依赖所需，先于 P0 落地）

relay 包依赖此前从未安装（catalog 缺项导致 install 无法解析）。为使 `pnpm install` 通过，做了以下最小调整：

- 根 catalog 补齐：`@modelcontextprotocol/core@2.0.0`、`@modelcontextprotocol/server@2.0.0`、`zod@4.4.3`（§2.4 原计划项）；另补 `@vitest/coverage-v8@^5.0.0`（上游 4.1.8 对应 vitest 4，本仓库 vitest ^5 须主版本一致）
- relay `devDependencies`：`@mcp-b/webmcp-polyfill` / `@mcp-b/webmcp-types` 从 `workspace:*` 改为 `catalog:`（本工作区无这两个包；它们只服务于 embed/旧 e2e，P0 时随删除面一并清理）
