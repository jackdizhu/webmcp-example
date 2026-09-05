# 项目规则

`webmcp-example` 工程专有规则。开发与 AI 代理执行任务时必须遵守。

## 1. 技术栈规则

- 工程使用 **TypeScript**（`.ts` / `.tsx`）编写。
- 包管理统一使用 **pnpm**（monorepo 工作区），禁止使用 npm / yarn 混用锁文件。
- 构建、类型检查、测试等脚本统一在根 `package.json` 中声明，通过 `pnpm` 执行。
- 浏览器端 WebMCP 能力优先复用上游包（`git-source/npm-packages` 提供的 `@mcp-b/*`）与 `git-source/webmcp-tools` 参考实现，避免重复造轮子。

## 2. 模块职责

| 模块 | 职责 | 禁止 |
| ---- | ---- | ---- |
| `packages/html-app` | Web 应用 SPA，通过 `document.modelContext.registerTool()` 暴露 WebMCP tools | 混入浏览器插件特权 API、在 main world 暴露密钥 |
| `packages/chrome-extension` | 浏览器插件，作为 agent 能力层发现 / 校验 / 执行页面 tools | 将页面逻辑直接编译进插件主包；依赖页面内部实现细节 |

依赖关系保持单向：`chrome-extension` 通过浏览器 API / MCP Client 调用 `html-app` 暴露的工具，不让 `html-app` 反向依赖插件内部实现。

## 3. 服务管理约束（最高优先级）

- **禁止自动执行**服务的停止、启动、重启命令（例如 `pnpm dev`、`pnpm build` 等长驻进程）。
- 涉及服务操作时，必须先与用户确认，由用户手动执行并确认结果。
- 允许执行只读检查（如 `pnpm --filter html-app typecheck`），不得擅自启停服务。

## 4. 文件大小检查

编辑或新建文件前预估大小：

- **阈值**：单文件超过 800 行或 4600 字。
- **处理**：超过阈值时，与用户确认是否拆分文件。
- **评估依据**：会话上下文对通用文本长度的限制。

## 5. 子模块与参考依赖

- `git-source/webmcp-tools`、`git-source/npm-packages` 为只读参考子模块，**不作为运行时依赖**。
- 升级 WebMCP 相关行为前，先对照 `git-source/npm-packages/AGENTS.md` 与 WebMCP 草案，确认当前 API 形态（如 `document.modelContext`、`executeTool`）后再改动。

## 6. 开发规范

- **命名**：变量名直接反映含义，避免缩写。
- **结构**：函数单一职责，避免过度耦合。
- **性能**：分析复杂度，避免指数级算法。
- **错误**：捕获具体异常，避免空处理。
- **测试**：覆盖正常、边界、异常、性能场景。
- **重构**：保持功能不变，小步迭代验证。

## 7. 提交规范

- 提交格式：`<type>(<scope>): <subject>`。
- scope：`chrome-extension`、`html-app`、`docs`、`rules`、`root`、`*`。

## 8. MV3 扩展页 CSP 约束（ chrome-extension 专属）

> 根因案例见 `issues/001-vue-runtime-template-csp-eval.md`（侧边栏白屏）。

- MV3 扩展页（Side Panel / popup / options / background）强制 CSP `script-src 'self'`，**不允许 `unsafe-eval`，且 manifest 无法放开**。
- **禁止**在扩展页代码中出现任何运行时求值：`eval`、`new Function`、Vue/框架的运行时字符串模板编译。
- Vue 组件在扩展页中**必须使用 `h()` 渲染函数**（构建期生成，零 eval）；`vue` 一律使用默认 runtime 构建，**禁止** alias 到 `vue/dist/vue.esm-bundler.js`（含编译器全量构建）。
- Vue 特性旗标（`__VUE_OPTIONS_API__` 等）必须通过构建 `define` 显式声明，缺失会残留未定义全局标识符（IIFE 产物下 ReferenceError）。
- 引入新的 UI 框架或模板类库前，先验证其运行机制不含 eval 类调用，否则按上一条同样处理（改渲染函数或换构建期预编译方案）。

## 版本历史

| 版本 | 日期 | 变更内容 |
| ---- | ---- | -------- |
| 1.1.0 | 2026-09-05 | 新增第 8 节：MV3 扩展页 CSP 约束（禁止运行时求值，Vue 用渲染函数） |
| 1.0.0 | 2026-09-05 | 初始版本：技术栈、模块职责、服务管理、开发规范 |