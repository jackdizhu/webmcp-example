# 实验方案：vp pack 挂载 @vitejs/plugin-vue 解锁 SFC

> 目标：用一次最小实验验证 `vite-plus@0.1.24` 的 `PackUserConfig.plugins` 能否承载 `@vitejs/plugin-vue`，在 MV3 扩展页 CSP 下跑通「构建期编译 SFC → 渲染函数产物」。
> 背景分析见 `rules/coding-style.md` §3「SFC 启用路径」与 `issues/001`。本文标注 **【已验证】/【推断】** 的结论均附证据位置。

## 0. 实验前提（已确认事实）

| # | 事实 | 证据 |
| - | ---- | ---- |
| 1 | `PackUserConfig` 类型暴露 `plugins?: TsdownPluginOption` | 【已验证】`node_modules/.pnpm/@voidzero-dev+vite-plus-cor_*/dist/tsdown/index-types.d.ts:2147` |
| 2 | tsdown 引擎消费用户插件（`plugins.push(userPlugins)`） | 【已验证】`vite-plus-core/dist/tsdown/build-*.js:6108,6147` |
| 3 | side-panel 构建组已含 `__VUE_*__` define 旗标、默认 runtime 构建 | 【已验证】`packages/webmcp-chrome-extension/vite.config.ts:35-42` |
| 4 | `plugin-vue` 与 rolldown 构建的实际兼容性 | 【推断】plugin-vue 使用标准 `transform` 等 rollup 兼容钩子，rolldown 支持该钩子族；`config`/`handleHotUpdate` 等钩子构建期无害。需实验证实 |
| 5 | plugin-vue 对 vite ^8.2.2 的 peer 匹配 | 【推断】未知，安装时以 npm peer 警告为准；pnpm 严格 peer 可能拦截安装 |

## 1. 分工与步骤

> 项目规则 §3：`pnpm install / build` 一律由**用户手动执行**；AI 负责代码改动与只读校验（typecheck / lint / test / 产物 grep）。

| 阶段 | 执行者 | 动作 |
| ---- | ------ | ---- |
| P1 代码准备 | AI | 完成 §2 的全部代码改动，跑三闸门（test/typecheck/lint）预检 |
| P2 安装依赖 | **用户** | `pnpm install`（观察 plugin-vue peer 警告，记录输出） |
| P3 构建 | **用户** | `pnpm --filter webmcp-chrome-extension build`（成功 / 失败输出都完整保留） |
| P4 产物校验 | AI | 只读验证，清单见 §3（全过才算实验成功） |
| P5 运行时验证 | **用户** | Chrome 加载 `dist/`，侧栏检查试点组件，清单见 §4 |
| P6 决策 | 用户 | 按 §5 决策门处置 |

## 2. 代码改动清单（P1，AI 执行）

| 文件 | 改动 | 说明 |
| ---- | ---- | ---- |
| `packages/webmcp-chrome-extension/package.json` | devDependencies 增加 `@vitejs/plugin-vue`（最新版） | plugin-vue 运行时依赖 `@vue/compiler-sfc`，构建期生效 |
| `packages/webmcp-chrome-extension/vite.config.ts` | `sidePanelBase` 增加 `plugins: [vue()]` | main/e2e 两个 side-panel 组共享 `sidePanelBase`，一次覆盖 |
| `main-extension/side-panel/components/sfc/PilotHello.vue` | 新增试点组件 | `<script setup lang="ts">` + 一个响应式计数按钮；**不含 `<style>` 块**（红线：样式仍归 `side-panel.html` 单一 style 块，绕开 tsdown CSS 资产不确定性） |
| `main-extension/side-panel/pages/DebugPage.ts` | 底部挂载 `PilotHello`（带「SFC 试点」标注） | 最低风险页面；仅实验期存在 |
| `main-extension/side-panel/sfc-shim.d.ts` | 新增 `declare module '*.vue'` | TS 识别 `.vue` 导入；dts:false 产物无影响 |

**明确不做**：不迁移任何现有 `h()` 组件；不改 html-app / relay / core；不动 manifest。

## 3. 产物校验清单（P4，AI 只读执行）

1. `dist/side-panel.iife.js` 与 `e2e-extension/dist/side-panel.iife.js` **均不含** `new Function(`、`eval(`（Grep 全文，命中即失败——复现 issues/001 白屏根因）。
2. 产物中存在试点组件编译痕迹（如 `PilotHello` 或其编译后的渲染函数片段），证明 SFC 确实走了构建期编译。
3. `dist/` 无多余的 `.css` 资产文件（若出现，说明 plugin-vue 的样式通道被触发，虽不阻断但需在结论中记录）。
4. 三闸门全绿：`test` / `typecheck` / `lint`（AI 用绝对路径 node 直跑，不经 pnpm）。
5. `manifest.json` 引用的四个产物文件齐全（side-panel / service-worker / content-script / main-world）。

## 4. 运行时验证清单（P5，用户执行）

1. `chrome://extensions` 重新加载扩展（id 应保持 `cfidfd…`，manifest 有 key）。
2. 打开侧栏：无白屏、无 `EvalError`（Console 干净）。
3. 调试页底部出现「SFC 试点」组件；点击按钮计数 **递增且视图更新**（证明构建期编译的渲染函数 + 响应式链路完整）。
4. 其余 6 页签回归：agent 对话 / 数据源 / A2A / 设置正常切换。

## 5. 决策门

| 结果 | 处置 |
| ---- | ---- |
| ✅ §3 + §4 全过 | 解锁 SFC：更新 `coding-style.md` §3（路径 1 转为「已验证可用」）、`issues/001` 补记结论；后续新组件可用 SFC，存量 `h()` 渐进迁移、不强迁；沉淀「SFC 试点组件」为惯例样板 |
| ⚠️ 构建过但产物含 eval / 侧栏白屏 | **实验失败即回滚**（见 §6），转路径 2（`@vue/compiler-sfc` 预编译外挂），失败现场记录进 `issues/001` 附录 |
| ❌ build 直接报错 | 同上回滚；错误信息决定是否尝试 plugin-vue 降版本或 rolldown 原生 SFC 插件调研 |

## 6. 回滚方案

```
git checkout -- packages/webmcp-chrome-extension/vite.config.ts
rm  main-extension/side-panel/components/sfc/PilotHello.vue
rm  main-extension/side-panel/sfc-shim.d.ts
git checkout -- main-extension/side-panel/pages/DebugPage.ts
（package.json 由 pnpm install 还原或手动移除 devDep）
```

全部为实验期新增/局部改动，无存储数据、无 manifest 变更，回滚零残留。

## 7. 风险与回退预案（推断项汇总）

| 风险 | 等级 | 预案 |
| ---- | ---- | ---- |
| plugin-vue peer 不匹配 vite ^8.2.2 | 中 | pnpm 安装警告不影响运行则忽略；严格拦截则降 pin 到 pnpm 可解析的最近版本（peer 兼容 vite 7 的 6.x），build 行为不受 vite 版本影响【推断：pack 用 rolldown，不加载 vite runtime】 |
| rolldown 不识别 plugin-vue 的某钩子 | 中 | 多数 vite 插件钩子构建期无害空转；若 build 报未知钩子错误，走决策门 ❌ 转路径 2 |
| SFC `<style>` 通道 | 低 | 实验组件不含 style，规避；后续如需 scoped 样式另行专项验证 |
| treeshake 误删编译产物 | 低 | define 旗标 + `deps.alwaysBundle` 已验证可用（现网 h() 同链路） |

## 附录 A：三条路径优劣对比

> 路径 1 = vp pack 挂 `@vitejs/plugin-vue`；路径 2 = `@vue/compiler-sfc` 预编译外挂；路径 3 = side-panel 单独原生 Vite。

| 维度 | 路径 1：vp pack + plugin-vue | 路径 2：compiler-sfc 预编译 | 路径 3：side-panel 原生 Vite |
| ---- | ---- | ---- | ---- |
| 改动范围 | **最小**：1 处配置 + devDep + 试点组件 | 中：新增自维护编译脚本 + 生成目录约定 | **最大**：双构建链，build/dev/产物合并逻辑全部对齐 |
| 构建链风险 | 中：plugin-vue × rolldown 兼容未实证【推断】 | **零**：vp pack 完全不动，产物即普通 `.ts` | 低：vite 8 官方支持 plugin-vue，但引入第二套链 |
| 开发体验（DX） | 中：构建期编译，无模板热更；vp watch 行为未验证 | 差：`.vue` 改动需先跑编译脚本，报错滞后一步 | **最好**：HMR + vue-tsc + scoped 样式全家桶 |
| 类型检查 | `.vue` 需 shim，模板表达式无类型保护 | 同左（另配 vue-tsc 可补，成本自理） | vue-tsc 完整模板类型检查 |
| 样式方案 | SFC 禁 `<style>`，维持 side-panel.html 单一 style 块 | 同左 | scoped style 可用（破坏「视觉层只有一处」现状，需新约定） |
| 维护成本 | 低：与现网链路共享全部机制（onSuccess、manifest 拷贝、IIFE） | 中高：自造编译器脚本要处理缓存 / watch / sourceMap，长期背着走 | 高：每次构建脚本、e2e 产物（e2e-extension-side-panel 同 entry）、dist 布局都要双链对齐 |
| e2e 构建影响 | 无（sidePanelBase 共享，e2e 组自动生效） | 无 | 需为 e2e 产物另出一份或复用主产物 |
| 回滚难度 | **容易**：还原 vite.config.ts + 删试点文件 | 容易：删脚本 | 难：涉及 package.json scripts、目录布局，牵连面大 |
| 长期演进 | 依赖 vite-plus 升级不破坏 plugins 口；h() 与 SFC 可并存渐进 | 与上游演进解耦，但自造轮子永远自己养 | 若未来全量切 Vite，此路径即过渡态，最顺 |
| 实验成本 | **最低**（10 分钟级，本方案主体） | 中（先写编译脚本才能开始实验） | 高（搭双链即半天级） |

**结论**：

1. **路径 1 是当前最优实验起点**——改动最小、证据已在类型与引擎层到位、失败回滚干净；成功则零额外维护成本拿到 SFC 能力。
2. **路径 2 是确定性保底**——不赌任何兼容性，但自维护编译脚本的长期成本使它只适合「路径 1 失败且仍要 SFC」的场景。
3. **路径 3 是规模化后的升级选项**——仅当 SFC 组件数量大到需要 HMR / vue-tsc / scoped 样式时再评估；当前体量（6 页签、组件不足 20 个）不值得双链维护。
4. 无论走哪条，三条硬红线不变：runtime 构建、define 旗标、产物无 eval 检查。
