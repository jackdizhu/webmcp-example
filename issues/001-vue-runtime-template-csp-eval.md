# 001 - 侧边栏白屏：Vue 运行时模板编译触发 MV3 CSP EvalError

| 项 | 内容 |
|---|---|
| 状态 | ✅ 已解决（2026-09-05） |
| 影响模块 | `packages/chrome-extension` / `main-extension/side-panel/` |
| 类型 | 缺陷（构建集成） |
| 严重程度 | 高（侧边栏完全不可用） |

## 现象

侧边栏打开后整页空白，控制台报错：

```
Uncaught EvalError: Evaluating a string as JavaScript violates the following
Content Security Policy directive because 'unsafe-eval' is not an allowed source
of script: script-src 'self'".
at new Function (<anonymous>)
```

## 根因

- MV3 扩展页（含 Side Panel）强制 CSP `script-src 'self'`，**不允许 `unsafe-eval`**，且 MV3 的 manifest 无法通过 `content_security_policy` 放开 eval。
- 侧边栏当时选择 Vue **运行时字符串模板编译**方案：`vite.config.ts` 把 `vue` alias 到 `vue/dist/vue.esm-bundler.js`（含编译器全量构建），运行时用 `new Function` 编译组件里的字符串 `template` → 直接命中 CSP，组件渲染中断 → 白屏。

## 修复方案

1. `App.ts` / `Debugger.ts` 的字符串 `template` 全部改写为 **`h()` 渲染函数**（构建期生成，零 eval）：
   - `v-model` → 手写 `value` + `onInput`（输入框/文本域）或 `checked` + `onChange`（复选框）；
   - `v-show` → `style.display`；
   - `@keydown.enter.exact.prevent` → `onKeydown` 内手写按键判断（回车发送、Shift+Enter 换行）。
2. `vite.config.ts` 去掉 `vue → vue.esm-bundler.js` 的 alias，`vue` 走默认 **runtime 构建**（已实证产物无 `new Function`；编译器被 tree-shake，产物更小）。
3. `__VUE_OPTIONS_API__` 等 `define` 旗标保留（缺失会残留未定义全局标识符，IIFE 下 ReferenceError）。

## 经验与约束（已沉淀到 `rules/project-rules.md` 第 8 节）

- **扩展页内禁止任何运行时求值**：`new Function`、`eval`、Vue 运行时模板编译均不可用。
- Vue 组件在扩展页中**必须使用渲染函数**（或构建期预编译的 SFC 方案，本工程 vite-plus 不支持插件，故选渲染函数）。
- 附带收益：渲染函数是纯 TS 代码，模板表达式纳入 typecheck 保护。

## 回归验证

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（49 passed）全绿。
- 产物级验证：重新 `build` 并加载 `dist/` 后侧栏正常渲染。
