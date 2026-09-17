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

## 后记（2026-09-17）：全量 TSX 迁移，SFC/plugin-vue 方案退场

- 侧栏 22 个组件/页面（App、6 个页面、15 个组件）已全量由 `.ts`（h() 渲染函数）与 `.vue`（SFC）统一迁移为 **`.tsx`**（三闸门全绿：tsc 0 错 / vitest 182 测试全过 / eslint 0 问题）。
- 2026-09-16 后记中的 plugin-vue 路径已**退役**：`@vitejs/plugin-vue` 从 `vite.config.ts` 与 `package.json` 移除（lockfile 同步待用户 `pnpm install`）。JSX 改由 vite-plus 内置 oxc 在构建期转译——按 `tsconfig.base.json` 的 `jsx: react-jsx` + `jsxImportSource: vue` 就近解析消费，产出 `vue/jsx-runtime` 的 `jsx()` 调用（内部实现即 `h(type, props, children)`），**运行时零 eval、零 eval 风险插件依赖**。
- 本文「Vue 组件必须使用渲染函数」的表述仍然成立且本质不变：TSX 编译产物就是渲染函数调用（`jsx()` 内部即 `h()`），只是书写层从手写 `h()` 换成 JSX 模板。
- 迁移中的新踩坑（已沉淀到 `rules/coding-style.md` §3 v1.6.0）：Vue 3.5 `vue/jsx-runtime` 类型缺 `children`，靠 `main-extension/side-panel/jsx-shim.d.ts` 模块增强 `ReservedProps`（该 `.d.ts` 必须含 `export {}`，否则 `declare module 'vue'` 变环境声明覆盖 vue 全部类型）；JSX 属性名不支持 kebab-case，emits 改 camelCase（运行时 camelize 归一，行为不变）。
- 现行规范见 `rules/coding-style.md` §3（v1.6.0）：组件一律 `.tsx`、tsconfig 驱动 oxc 零插件依赖、运行时字符串模板禁令不变；SFC 实验历史见 `docs/sfc-plugin-experiment-plan.md`（已转历史档案）。

## 后记（2026-09-16）：SFC 解锁，约束边界收窄

- 本 issue 禁令的准确边界是「运行时求值」，而非「SFC」。SFC 经构建期编译即渲染函数，运行时零 eval。
- 实验（`docs/sfc-plugin-experiment-plan.md` 路径 1）已通过：`vite.config.ts` sidePanelBase 挂 `plugins: [vue()]`（`@vitejs/plugin-vue@^6.0.9`）后 `vp pack` 构建成功，`dist/side-panel.iife.js` 产物级检查**无 `new Function` / `eval`**，试点组件 `PilotHello.vue` 编译痕迹在。
- 本文原表述「本工程 vite-plus 不支持插件」**已证伪**：`PackUserConfig` 类型实际含 `plugins?: TsdownPluginOption`（vite-plus-core `dist/tsdown/index-types.d.ts:2147`）。
- 现行规范见 `rules/coding-style.md` §3（v1.5.0）：SFC 块顺序固定 `template` → `script`、禁 `<style>` 块、放 `components/sfc/`；运行时字符串模板禁令不变。
