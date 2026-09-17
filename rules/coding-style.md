# 编码规范（webmcp-example 适配版）

基于通用「前端 AI Agent TypeScript 编码规范 v2.0」修订，对齐本工程实际技术栈与已踩坑约束。
分工边界：工程管理（命令 / 模块职责 / 服务启停 / 提交格式）见 `project-rules.md`；输出语言、编码、注释语言层面规则见 `language-rules.md`；代码写法规范（含命名、注释结构、文件大小）统一在本文件维护。

## 1. 质量评估维度与权重

| 维度 | 权重 | 评估标准 | 评估目标 |
| :--- | :--- | :--- | :--- |
| **可维护性** | **25%** | 模块按职责拆分，逻辑复用性高，状态流向清晰。 | UI 与逻辑解耦，需求变更成本低。 |
| **稳定性** | **25%** | 无运行时崩溃，消息通道生命周期安全，错误边界完善。 | 用户操作不卡顿、不白屏。 |
| **可阅读性** | **20%** | 命名语义直白，TSX 模板结构清晰，逻辑一目了然。 | 协作开发无痛点，代码即文档。 |
| **低复杂度** | **15%** | 单文件行数受控，Watch/Effect 依赖少。 | 避免渲染性能陷阱与超长文件（阈值见 `project-rules.md` §4）。 |
| **扩展性** | **15%** | 工具颗粒度合理，MCP 工具易于插拔。 | 支持快速接入新能力。 |

## 2. TypeScript 通用规范（全包适用）

基于 `tsconfig.base.json` 实际开启的编译旗标，以下为硬约束：

*   `strict: true` 已开启，附加 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitReturns`、`noImplicitOverride`、`noFallthroughCasesInSwitch`。写代码时按最严格形态书写：
    *   索引访问结果视为 `T | undefined`，使用前判空（`noUncheckedIndexedAccess`）。
    *   可选属性传参时不要显式传 `undefined` 之外的隐式宽松写法（`exactOptionalPropertyTypes`）。
*   **严禁 `any`**：所有代码一律禁止使用 `any`（含 `as any` 断言与泛型实参）。背景：ESLint 层面 `no-explicit-any` 已关闭（`eslint.config.mjs`，为兼容移植代码），因此该规则**靠人工纪律执行，属于本文件硬约束**：
    *   类型不确定时用 `unknown` + 类型收窄（类型守卫 / zod 解析），不用 `any`。
    *   第三方 SDK 类型缺陷用 `@ts-expect-error` + 注释，或局部声明补充类型，不改用 `any`。
    *   移植代码中的存量 `any` 不主动扩散；触碰到的改动点顺手收敛为显式类型。
*   **未使用变量**：统一加 `_` 前缀豁免（`argsIgnorePattern: '^_'`），不要留无前缀的死代码。
*   **禁止** `@ts-ignore`；确需压制用 `@ts-expect-error` 并注释原因，且仅限第三方库类型缺陷。
*   **跨包导入**：共享领域逻辑进 `webmcp-agent-chat-core`（零 UI、零浏览器 API）；`git-source/*` 是只读参考，禁止作为运行时 import。

### 2.1 通用代码质量规范（全包适用）

> 依据通用权威规范归纳：Clean Code（Robert C. Martin）、Google / Airbnb JavaScript Style Guide、DRY / KISS / YAGNI / SOLID 等业界共识。行数等阈值按本工程实际调整；语言与注释风格细节以 `language-rules.md` 为准，本节不重复。

**命名规范**

*   名字要**揭示意图**：变量 / 函数命名直接反映语义，读名字即可知道它是什么 / 做什么，无需回看实现；避免费解的缩写。可搜索性优先于简短性。
*   函数用动词开头（`getUserById`、`calculateTotal`）；类 / 组件 / 类型用名词（`UserProfile`）；变量用名词。
*   大小写约定：变量 / 函数 `camelCase`；类 / 组件 / 类型 `PascalCase`；常量 `UPPER_SNAKE_CASE`（如 `MAX_NODES`）。
*   禁止缩写（`btn`、`msg`、`usr`、`idx`），公认缩写除外（`URL`、`API`、`id`、`WS`）；循环索引允许 `i` / `j`。
*   禁止匈牙利命名（`strName`、`intCount`）与冗余上下文（`user` 对象内命名 `user.userName` → 应为 `name`）。
*   布尔命名用 `is` / `has` / `can` / `should` 前缀，禁止否定式命名（`isNotReady` 造成双重否定）。

**函数设计**

*   **单一职责**：一个函数只做一件事；描述它需要用到「并」「且」时就该拆分。每个函数只有一个变更理由。
*   函数体本工程阈值 ≤ 50 行（Clean Code 理想 ≤ 20 行），超过即拆分子函数；一段逻辑被「// 第一步…// 第二步…」注释切分时就是拆分信号。
*   **参数 ≤ 3 个**：更多时聚合为对象参数（`createUser(profile, address)` 而非九个散参）。
*   **禁止布尔旗标参数**（`save(order, true)`）：拆成 `saveDraft` / `publish` 两个函数。
*   **单一抽象层次**：同一函数内不混排「高层编排」与「底层细节」，细节下沉到子函数。
*   **命令查询分离**：函数要么做事（命令），要么返回值（查询），不隐蔽地两者兼做。
*   优先纯函数：相同输入必得相同输出、无副作用；副作用（网络 / 存储 / DOM）集中在边界层（与 `webmcp-agent-chat-core` 零浏览器 API 的定位一致）。
*   无参数时省略 `()` 之外的冗余；不需要 `this` 绑定的回调一律箭头函数。

**复杂度控制**

*   圈复杂度 ≤ 10；超出时拆分子函数或改为查表结构。
*   嵌套深度 ≤ 3 层：`if` 内嵌 `for` 内嵌 `if` 即到顶。用提前返回（guard clause）压平嵌套，避免「箭头形」代码。
*   多分支映射优先用对象 / `Map` 查表（键 → 处理函数），不用长串 `else if` / `switch`。
*   循环体内禁止做可提到循环外的常量计算与重复查找。
*   优先用 `filter` / `map` / `reduce` 等声明式集合操作替代手写索引循环（性能敏感的热路径除外，此时注释说明理由）。

**短路优先与条件写法**

*   **短路优先**：先判空、判边界、判权限，不满足立即 `return` / `continue`，主逻辑保持在最低缩进层级。
*   默认值回退用 `??`（空值合并），不用 `||`——避免 `0`、`''`、`false` 被误判为缺失。
*   多层判空优先用可选链 `?.`，配合 `??` 给兜底值；超过两层的 `a && a.b && a.b.c` 应改为 `a?.b?.c`。
*   三目运算符只用于简单二选一取值；带副作用的分支逻辑用 `if`，禁止三目嵌套超过一层。
*   相等比较用 `===` / `!==`，禁止 `==` / `!=` 的隐式类型转换。
*   复杂布尔条件提取为命名布尔变量或 `isXxx()` 谓词函数。

**数据与状态**

*   声明优先 `const`，需要重新赋值才用 `let`；禁止 `var`。
*   优先不可变风格：不改入参，用展开 / 拷贝生成新对象返回；确需原地修改时在函数名中体现（如 `sortXxxInPlace`）。
*   避免跨模块共享的可变全局状态；模块级可变量必须有明确的单一写入方。
*   字面量构建用 `[]` / `{}`，不用 `new Array()` / `new Object()`；数组复制用展开而非引用赋值。
*   魔法数字 / 字符串提取为具名常量或枚举（`const MAX_NODES = 1200`），同一语义的阈值全工程只定义一次。

**注释与自文档**

*   **代码自解释优先**：需要「what」级注释时先重构命名 / 结构，注释只写「why」——非显然的业务规则、踩坑根因、性能取舍、外部约束。
*   **注释结构**：按「总体 → 定义 → 举例 → 详细」四层组织必要的注释，次要逻辑不必逐行注释。
*   公共导出 API 用 JSDoc（`@param` / `@returns`）。
*   禁止保留注释掉的死代码——git 历史可查，直接删除；`TODO` / `FIXME` 必须关联 issue 或说明条件。
*   禁止 console.log 遗留在提交里（调试输出用项目既定日志通道）。

**错误处理**

*   **快速失败**：边界处校验入参，不合法立即抛错或返回错误，不带病继续计算。
*   禁止空 catch 与吞异常：必须处理、转为带上下文的具体错误、或原样上抛；错误信息可定位（含关键参数，注意脱敏，见 `issues_rules.md`）。
*   异步统一 `async/await` + `try/catch`，禁止裸 `.then` 链嵌套回调；并发无依赖任务用 `Promise.all`，但每个任务各自兜底，禁止未处理的 rejection。
*   外部调用（网络 / 存储 / 第三方 SDK）在边界层统一包裹，错误不在业务逻辑深处裸抛。

**代码组织**

*   文件内顺序：import → 类型 → 常量 → 主逻辑 → 辅助函数。
*   **文件大小**：单文件不超过 800 行，超出时按功能点拆分模块（阈值来源与确认流程见 `project-rules.md` §4）。
*   相关代码放在一起：强相关的函数 / 常量物理就近；一个文件一个主题（一个组件 / 一类职责）。
*   模块间依赖最小化、保持单向（呼应 `project-rules.md` §2 的依赖方向约束）。

**设计原则**

*   **DRY**：同一逻辑出现第三次前必须提取复用（Rule of Three）；为两个调用点过早抽象同样禁止。
*   **KISS**：先给能工作的最简单方案，拒绝炫技式写法与不必要的间接层。
*   **YAGNI**：只实现当前需要的能力，不为「将来可能」预留抽象与配置项。
*   **SOLID**（模块 / 类层面）：单一职责；对扩展开放、对修改封闭——加行为优先新增而非改动已验证代码；依赖抽象接口而非具体实现（relay / transport 层注入即此模式）。
*   **童子军规则**：改到哪清到哪，触碰到的坏味道顺手修复，但不做无关大扫除。

**性能与安全**

*   先测量后优化：无 profiling 证据不做微优化；优先优化算法复杂度而非语句级技巧。
*   昂贵的计算做缓存 / 记忆化；大列表与重资源延迟加载。
*   不信任外部输入：所有来自 Agent / 网络 / 用户的参数先校验（页面工具与 relay 层已有 zod / schema 校验要求，见 §5 / §6）。
*   优先标准库与既有依赖能力，新增第三方依赖前确认项目内无等价实现。

**重构触发信号**

出现以下信号即应计划重构：重复代码、超长函数 / 超大类、依恋其他模块数据的函数、总是捆绑出现的数据泥团、每次改动都波及多处（霰弹式修改）、注释解释不了为什么只能解释做什么。重构保持功能不变、小步迭代验证（呼应 `project-rules.md` §6）。

## 3. Vue 3 in MV3：TSX 规范（chrome-extension 专属）

> 根因案例见 `issues/001-vue-runtime-template-csp-eval.md`；CSP 规则全文见 `project-rules.md` §8。2026-09-17 已全量迁移 TSX（22 个组件/页面 `.tsx`），取代早期 h() 渲染函数与 SFC（`@vitejs/plugin-vue`）双轨方案。

*   **禁止的是运行时求值，不是模板语法本身**：扩展页 CSP 禁 `unsafe-eval`。TSX 在**构建期**由 vite-plus 内置的 oxc 转译为 `vue/jsx-runtime` 的 `jsx()` 调用（内部实现即 `h(type, props, children)`），运行时零 eval，CSP 安全。**运行时字符串 `template` 仍一律禁止**（`vue.esm-bundler` alias 同禁）；模板指令知识迁移为 JSX 写法：条件用三目 / `&&`，列表用 `arr.map()`，`v-model` 手写 `value` + `onInput`（复选框用 `checked` + `onChange`）。
*   **组件一律 `.tsx`，构建链纯 tsconfig 驱动、零插件依赖**：
    *   `tsconfig.base.json` 固定 `"jsx": "react-jsx"` + `"jsxImportSource": "vue"`，同时驱动 tsc 类型检查与 oxc 构建转译（oxc 转换时按文件就近解析 tsconfig 消费这两个字段）。**不得在 vite.config `PackUserConfig` 里另配 oxc**（类型不收）；oxc 默认 importSource 是 `react`，漏配 tsconfig 会把 JSX 错链到 react——新增 tsconfig 时必须同步这两字段。
    *   **不使用 `@vitejs/plugin-vue` / `.vue` SFC**（2026-09-17 已从 vite.config 与 package.json 移除；SFC 实验历史见 `docs/sfc-plugin-experiment-plan.md`）。
    *   **JSX 类型 shim**：`main-extension/side-panel/jsx-shim.d.ts` 模块增强 `declare module 'vue' { interface ReservedProps { children?: unknown } }`（Vue 3.5 `vue/jsx-runtime` 未声明 children 的官方缺口，缺失则全量 .tsx 报 TS2322）。该 `.d.ts` 必须含 `export {}` 使文件成为模块——否则 `declare module 'vue'` 被解析为环境模块声明，覆盖 vue 全部类型（症状：`Module 'vue' has no exported member 'ref'` 全量爆红）。
*   **TSX 写法约束（Vue JSX 特有，与 React 不同）**：
    *   **emits 用 camelCase**：JSX 属性名不支持 kebab-case（`onToggle-settings` 非法）；`'update:xxx'` 例外——namespaced 属性 `onUpdate:modelValue` 合法。Vue 运行时对 emit 名称做 camelize 归一，camelCase 声明与调用行为不变。
    *   具名 slot 用 children 对象传函数：`{{ actions: () => [...] }}`；默认 slot 直接写 JSX 子节点。
    *   SVG kebab 属性（`stroke-width` / `stroke-linecap`）、`aria-*`、`for`、`spellcheck` 在 Vue JSX 类型中直接可用，无需改名。
*   **`vue` 一律默认 runtime 构建**，禁止 alias 到 `vue/dist/vue.esm-bundler.js`；Vue 特性旗标必须经构建 `define` 显式声明。
*   **响应式**：
    *   优先 `ref`；仅在对象结构固定且需深层响应式时用 `reactive`。
    *   **严禁直接解构 `reactive` 对象**，用 `toRefs` / `storeToRefs`。
    *   **陷阱（已踩坑）**：push 进 `reactive` 数组必须 push **代理对象**，push raw 对象会原位变更绕过响应式（症状：工具响应不立即展示）。
    *   避免深层 `watch` 大对象，精确监听具体属性或用 `computed` 派生。
*   **组件组织**：组件用 `.tsx` + 固定类名，放 `components/`；页面放 `pages/`；`App.tsx` 只做编排。纯类型文件用 `.ts`（如 `components/types.ts`）。复用逻辑提取为 `useXxx` 组合函数。
*   **样式**：侧栏视觉层在 `main-extension/side-panel/style/` 目录，按页面/组件拆分为独立 CSS 文件（2026-09-16 由单一 `side-panel.css` 拆出；更早的 2026-09-15 由 side-panel.html 内联 `<style>` 拆出）——`tokens`（设计令牌）/ `base`（reset、按钮基线、聚焦环、滚动条）/ `shared`（子页面框架、模式切换行、空态）/ `header` / `tabs` / `chat` / `relay` / `datasource` / `a2a` / `settings` / `debug` 共 11 个文件，另设 `index.css` 聚合入口（`@import` 按序引入全部文件），HTML 仅经单一 `<link>` 引入 `index.css`，**index.css 内 `@import` 顺序即级联顺序，不可乱序**（新增拆分文件须同步追加 import）；构建时 HTML + style 目录整体拷入 dist（`copySidePanelHtml`）。组件零内联样式、零 scoped 样式，改某页样式只动对应文件（不可能影响行为）；状态推导优先用 `:has()`，避免类名扩散。

## 4. chrome-extension：消息通信与注入规范

*   **Port 消息**：`chrome.runtime.Port.postMessage` 一律 try/catch 包裹——端口生命周期不归发送方控制，对端已断开时抛异常。
*   **扩展页 → content script** 必须用 `chrome.tabs.connect(tabId)`；`runtime.connect` 到不了 content script。
*   **回调式 API**：凡 callback 风格的 `chrome.*` 调用必须检查 `chrome.runtime.lastError`。
*   **传输握手**：`TabClientTransport` 握手是一次性探测，消费方必须自带超时 + 有限重试；扩展 reload 后旧页面必须刷新，不得假设长连接永活。
*   **脚本注入**：`chrome.scripting.executeScript` 注入的函数必须**自包含**（不引用模块级标识符）；注入环境调用 fetch 用裸标识符形态（`obj.fetch()` 会被 Illegal invocation）。
*   **状态持久化**：不假设 SW / content script 永活，跨会话状态入 `chrome.storage`；SW 侧单一事实源用存储键 + watch 模式（参考 `tab-source-manager`）。
*   **注册顺序**：客户端条目登记必须先于 `client.start()`——start 同步 emit connecting，顺序颠倒状态快照缺标题。
*   **权限最小化**：`manifest.json` 仅请求必要的 `host_permissions`。

## 5. WebMCP 工具规范

*   **工具单一职责**：每个 Tool 只做一件事，不合并「读取 + 解析」类复合操作。
*   **内置工具结果**：必须返回 MCP `CallToolResult`，统一经 `toBuiltinToolResult()` 出口（relay 端有 schema 校验）。
*   **modelContext 判空**：`document.modelContext` 是可选 API，使用前必须判空（配合 `@mcp-b/webmcp-polyfill`）。
*   **inputSchema**：工具无参数时声明 `inputSchema.properties` 为 `Record<string, never>`，不得省略。
*   **页面工具命名**：全部页面工具统一加 `tab<id>__` 前缀（panel-client rebuildRoutes 已统一处理）；relay 端命名规则另行维护，不要混用。
*   **Agent 能力接入**：侧栏工具合成链固定为 `connectPageTools` → `attachBuiltinTools` → `attachInjectedTools`，新增工具按此链挂接，不绕过。

## 6. relay（Node 端）规范

*   **输入校验**：所有来自网络 / Agent 的参数经 **zod** schema 校验后再处理，防注入。
*   **错误不崩进程**：服务端错误返回 MCP 标准错误响应，不在请求路径上裸抛；异步任务统一兜底 catch。
*   **WebSocket**：连接生命周期（断开 / 重连 / 清理）必须显式管理；消息格式与 MCP SDK 类型对齐。

## 7. html-app 规范

*   通过 `document.modelContext.registerTool()` 暴露 WebMCP tools，**禁止**混入浏览器插件特权 API、禁止在 main world 暴露密钥。
*   不反向依赖 chrome-extension 内部实现，依赖单向（见 `project-rules.md` §2）。

## 8. 测试规范

*   框架统一 **vitest**，每包 `pnpm --filter <pkg> test`（只读校验，AI 可直接跑）。
*   覆盖正常、边界、异常、性能场景；SW / 存储相关单测遵循既有桩模式（如 `tab-source-manager` 的 `tabs.set(N,…)` + `activeTabId` 期望建连、stubs 追加式记录）。
*   三闸门（test / typecheck / lint）改动后全绿才算完成；命令细节见 `project-rules.md`。

## 9. 工具链与提交

*   **格式化**：无 Prettier，统一 `eslint . --fix`（`pnpm format`）。
*   **提交**：`<type>(<scope>): <subject>`，scope 取值见 `project-rules.md` §7。
*   **版本**：Changesets 管理（`pnpm changeset` / `version` / `release`）。
*   **禁令重申**：`pnpm dev/build/install` 一律由用户手动执行（最高优先级，见 `project-rules.md` §3）。

## 10. AI 生成代码指令

要求 AI 生成代码时使用以下 Prompt，确保符合本工程规范：

> **Role**：精通 TypeScript、Chrome MV3 扩展、Vue3 TSX 与 MCP 协议的前端专家。
> **Context**：我们在维护一个 pnpm monorepo：MV3 扩展（Vue TSX，构建期经 oxc 转译为零 eval 产物，CSP 禁 eval）+ WebMCP 页面工具 SPA + Node WebSocket relay + 纯逻辑共享库。
>
> **Coding Standards (Strict)**：
> 1. **Vue**：组件一律 `.tsx`（构建期 oxc 按 `tsconfig.base.json` 的 `jsx`/`jsxImportSource: vue` 转译为 `vue/jsx-runtime`，零 eval）；运行时字符串模板 / `eval` 一律禁止；emits 用 camelCase（`'update:xxx'` 例外）；reactive 数组 push 必须用代理对象。
> 2. **TS**：按 `tsconfig.base.json` 全量严格旗标书写；**严禁 `any`**，不确定类型用 `unknown` + 收窄。
> 3. **消息通信**：`Port.postMessage` try/catch；扩展页→content script 用 `tabs.connect`；注入函数自包含。
> 4. **MCP 工具**：单一职责；内置工具结果经 `toBuiltinToolResult()` 返回 `CallToolResult`；`document.modelContext` 判空。
> 5. **Node 端**：zod 校验入参，错误返回标准响应不崩进程。
> 6. **复杂度**：单文件 ≤ 800 行（超出先与用户确认拆分）；函数单一职责、≤ 50 行；圈复杂度 ≤ 10；嵌套 ≤ 3 层，短路优先提前返回；默认值用 `??` 不用 `||`。
> 7. **命令**：只跑 typecheck / lint / test 只读校验，不执行 dev / build。
>
> 请基于以上规范，生成[具体任务]的代码。

## 版本历史

| 版本 | 日期 | 变更内容 |
| ---- | ---- | -------- |
| 1.6.0 | 2026-09-17 | 全量 TSX 迁移：侧栏 22 个组件/页面由 `.ts`（h()）与 `.vue`（SFC）统一改为 `.tsx`；§3 改写为 TSX 规范——tsconfig 驱动 oxc（`jsx: react-jsx` + `jsxImportSource: vue`）零插件依赖、jsx-shim.d.ts 补 Vue 3.5 children 类型缺口（须 `export {}`）、emits camelCase（`'update:xxx'` 例外）；`@vitejs/plugin-vue` 已从 vite.config/package.json 移除（lockfile 同步待用户 `pnpm install` + `pnpm build` 实证）；SFC 实验文档转历史档案 |
| 1.5.1 | 2026-09-16 | 侧栏样式按页面/组件拆分：`side-panel.css` → `style/` 目录 11 文件（tokens/base/shared/header/tabs/chat/relay/datasource/a2a/settings/debug）+ `index.css` 聚合入口（`@import` 按序引入，顺序即级联顺序）；HTML 单 `<link>` 引入 index.css、vite 拷贝逻辑/§3 样式条款同步更新（选择器集合校验 252=252 零丢失） |
| 1.5.0 | 2026-09-16 | SFC 正式解锁：路径 1（vp pack + `@vitejs/plugin-vue@^6.0.9`）构建期验证通过（dist 无 `new Function`/`eval`，试点组件编译痕迹在）；§3 新增 SFC 组件规范——**块顺序固定 `template` → `script`**、禁 `<style>`、放 `components/sfc/`、与存量 `h()` 并存渐进迁移；AI 生成指令同步 |
| 1.4.1 | 2026-09-15 | 侧栏样式拆分为独立 `side-panel.css`（HTML 13 行 + CSS 562 行，同步修正「1515 行超阈值」的不实记忆）；§3 样式条款与 SFC 路径表述同步更新 |
| 1.4.0 | 2026-09-15 | §3 澄清「禁止 SFC」的真实边界：CSP 禁的是运行时模板编译，构建期 SFC 本身安全；修正「vite-plus 不支持插件」的早期结论（PackUserConfig 类型实际含 `plugins?: TsdownPluginOption`），新增三条 SFC 启用路径与共同红线 |
| 1.3.0 | 2026-09-15 | 整合 `language-rules.md` §4 代码风格三条规则：命名语义直白并入命名规范首条、「总体→定义→举例→详细」四层注释结构并入注释与自文档、单文件 ≤800 行并入代码组织（引用 project-rules §4 确认流程）；language-rules 侧改为交叉引用 |
| 1.2.0 | 2026-09-15 | §2.1 依据通用权威规范（Clean Code、Google / Airbnb JS Style Guide、DRY/KISS/YAGNI/SOLID）全面扩充：新增命名规范、函数设计（参数 ≤3、禁旗标参数、单一抽象层次、命令查询分离）、数据与状态（const 优先、不可变风格）、注释与自文档（只写 why、禁死代码）、错误处理（快速失败、边界包裹）、代码组织、设计原则、性能与安全、重构触发信号九个小节 |
| 1.1.0 | 2026-09-15 | `any` 规则升级为严禁（ESLint 已关闭该检查，靠纪律执行）；新增 §2.1 通用代码质量规范：单一职责、复杂度控制（≤50 行 / 圈复杂度 ≤10 / 嵌套 ≤3 层）、短路优先、`??` 回退、可选链等条件写法；同步更新 AI 生成指令 |
| 1.0.0 | 2026-09-15 | 适配重写：对齐实际 4 包 monorepo 技术栈；SFC/模板规范改为 h() 渲染函数；本地 MCP Server 章节替换为 WebMCP 工具 + relay 规范；沉淀 Port 消息、注入、注册顺序等已踩坑约束 |

