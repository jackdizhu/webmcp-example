# App.ts 页面级功能归拢分析（agent-profiles P1 前置调整）

> 状态：前置分析 v2（P1 实施依据，未动代码；v2：agent 对话编排按决策拆入独立公共共享库）
> 日期：2026-09-12
> 依据约定：side-panel 分层约定 —— 独立可复用组件 → `components/`；页面功能级视图 → `pages/`；**根 App.ts 只做状态与编排**（AGENT.md / 项目记忆）
> 分析对象：`packages/webmcp-chrome-extension/main-extension/side-panel/App.ts`（505 行）
> 对照范本：`DebugPage.ts`（页面级逻辑已在页内自持 + `debugger-core.ts` 纯逻辑抽离，是五个页面中分层最彻底的实现）

---

## 1. 结论速览

App.ts 现有 505 行中，按归属判定分四类：

| 归属判定 | 内容 | 处置 |
| --- | --- | --- |
| **A. 页面级，应下沉** | DataSourcePage 的选择操作（2 个函数）、SettingsPage 的日志管理（3 函数 + 2 状态 + 1 watch） | 迁入对应页面 |
| **B. 跨页共享的领域逻辑，应抽模块** | agent 对话轮次编排（runTurn/applyEvent/send/handoff/history/abort）、relay 状态订阅与 diff 日志 | 抽 `chat-controller.ts` / `relay-status-store.ts`（非 UI 纯逻辑，可单测），App 只接线 |
| **C. 真全局，留在 App** | 页面路由与执行锁、客户端生命周期（pageTools/relayStatusClient 建连断连）、工具数与连接状态、全局终止入口 | 不动 |
| **D. 混合副作用，拆分后归位** | persistSettings（存储 + 全局开关 + 路由 + 对话消息四域混写）、toPanelSettings | 拆分：序列化进 panel-client，副作用保留 App 编排 |

预估调整后 App.ts 从 505 行降至约 300–330 行，且 P1 新增的智能体状态（activeAgentId、profile 管理、切换提示）有明确落点（chat-controller + ChatPage），不会继续膨胀 App。

## 2. 逐项归属判定（证据 = App.ts 当前行号）

### 2.1 A 类：页面级，下沉到页面

| # | 现状（App.ts） | 行号 | 判定依据 | 去向 |
| --- | --- | --- | --- | --- |
| A1 | `toggleRelayTab`：勾选 checkbox → 组合新选中集 → 发 SW `set-selection` + 日志 | 243-250 | 仅由 DataSourcePage 的 checkbox 触发；且页面已持有 `relayStatus` client prop（DataSourcePage.ts:39），连接刷新按钮（recreateConnection，DataSourcePage.ts:121-133）已是**页面内直接发请求**的同款模式——同页同语义却分居两层 | 迁入 `DataSourcePage`：删除 `toggle-tab`/`reset-selection` 两个 emits（DataSourcePage.ts:41-47），页面内直接 `props.relayStatus.sendRequest` + `logEvent` |
| A2 | `resetRelaySelection`：发 SW `reset-selection` + 日志 | 252-256 | 同上，仅数据源页触发（onMounted 的一次性 reset-selection 属全局初始化，留在 App） | 同上 |
| A3 | `logCountText`/`logHint` 状态 + `refreshLogCount`/`handleExportLogs`/`handleClearLogs` | 333-334, 336-356 | 只服务设置页的日志区块展示；logger 函数（`logCount`/`exportLogs`/`clearLogs`）页面可直接导入，无跨页依赖 | 迁入 `SettingsPage`：状态自持、直接调 logger；App 删除对应 props 传递（SettingsPage.ts:15-16 的 `logCountText`/`logHint` props与 App 侧 3 处 props 注入一并移除） |
| A4 | `watch(activeTab)` 的 settings 分支：进设置页刷新日志条数 | 359-364 | 页面激活钩子；DebugPage 已有同款「watch props.active 刷新」模式（DebugPage.ts:63-69），页面自管激活刷新是既定范式 | 迁入 `SettingsPage`：`watch(() => props.active)` |
| A5 | `toPanelSettings`：响应式 settings → 持久化快照序列化 | 305-316 | 与 `saveSettings`/`loadSettings` 同属持久化协议；panel-client 已有 `loadSettings` 做反向填充（App.ts:371-380），序列化函数与加载函数分居两层不对称 | 迁入 `panel-client.ts`（与 `saveSettings` 相邻导出），App 调用 `toPanelSettings(settings)` |

### 2.2 B 类：跨页共享领域逻辑，抽非 UI 模块

| # | 现状（App.ts） | 行号 | 判定依据 | 去向 |
| --- | --- | --- | --- | --- |
| B1 | agent 对话轮次编排：`history`/`chatAbort`、`runTurn`（工具刷新 → LLM 构建 → 循环 → 错误分型）、`applyEvent`（事件→toolTrace）、`send`、`handleHandoff` | 80-82, 131-155, 158-236, 278-283, 286-290 | **不是单页逻辑**：`runTurn` 同时被 ChatPage 的 `send` 与 DebugPage 的 `handleHandoff` 调用；`runTurn` 内还耦合路由跳转（apiKey 缺失 → `setTab('settings')`）与消息注入。归入任何一页都会制造反向依赖 | **新建独立公共共享库包 `packages/webmcp-agent-chat-core`**（用户决策 v2：拆到公共共享库、导入使用）：连同领域核心 `agent-loop.ts`、`llm-client.ts` 一并迁入，外加新建的编排控制器；chrome-extension 以 `workspace:*` 导入消费。详见 §2.5 |
| B2 | relay 状态消费：`relayStateCache` + `applyRelayStatuses`（状态 diff → 日志）、`invokeLogs` 环形缓冲、`relayRunningCount`/`relayTerminated` + watch | 77-78, 84-97, 258-276 | 被**四个消费端**共享：RelayStatusBar（状态条）、DataSourcePage（checkbox 列表）、RelayPage（调用日志）、agent/调试（`setTargetTabs`）。页面化会造出多页互读；但逻辑体量（diff 日志 + 缓冲 + 锁计数）已超出「App 只做编排」的合理范畴 | 新建 `relay-status-store.ts`：封装「订阅 relayStatusClient → 维护 reactive 状态（statuses/selection/invokeLogs/runningCount/terminated）+ diff 日志」，导出 reactive store 与 dispose；App 持有实例并分发 props |

### 2.3 C 类：真全局，留在 App（不动）

| # | 内容 | 行号 | 理由 |
| --- | --- | --- | --- |
| C1 | 页面路由 `activeTab`/`setTab` 守卫、执行锁 `locked`/`phaseLabel` | 64-65, 100-112 | 锁 = busy（chat）∨ relayRunningCount，跨页语义；TabBar 消费 |
| C2 | 客户端生命周期：`pageTools` 建连/订阅/断开、`relayStatusClient` 建连/订阅、onMounted 初始化（settings 加载、reset-selection、refreshTools）、onUnmounted 清理 | 66-76, 366-433 | 全局单例资源，App 是唯一合理持有者 |
| C3 | `messages`/`input`/`busy` 对话消息状态、`pushUiMessage` | 47-49, 114-118 | 跨页写入（ChatPage 轮次、DebugPage handoff、persistSettings 提示消息），随 B1 的 controller 依赖注入保留 App |
| C4 | `connected`/`toolsCount`/`refreshTools` | 50-51, 120-128 | AppHeader 全局展示 + 多处触发 |
| C5 | `terminate` 全局终止入口 | 293-302 | TabBar「终止」按钮；内部拆两部分——chat abort 调 controller 方法，relay 部分调 store 方法，App 只做分派 |

### 2.4 D 类：混合副作用，拆分归位

| # | 现状（App.ts） | 行号 | 拆分方案 |
| --- | --- | --- | --- |
| D1 | `persistSettings`：saveSettings（存储）+ setConsoleOutput（全局即时生效）+ setTab + pushUiMessage（提示语）+ refreshTools | 318-330 | 序列化部分已由 A5 归位 panel-client；其余四步全部是**跨域编排副作用**（路由、对话消息、全局工具刷新），符合「App 只做编排」定位 → 留在 App，仅瘦身（不再手写字段列表） |

### 2.5 B1 落地形态：公共共享库 `packages/webmcp-agent-chat-core`

**包定位**：agent 对话领域的**纯逻辑共享库**——对话循环、LLM 协议适配、轮次编排控制器，零 UI、零浏览器/扩展 API 依赖，可被任意宿主（chrome-extension、relay、html-app、未来 Node 服务）导入使用。

**迁入内容与新建内容**：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `agent-loop.ts` | 迁自 side-panel | 循环本体 + `trimHistory` + 消息/工具类型（现 204 行，逻辑零改动） |
| `llm-client.ts` | 迁自 side-panel | openai-compat / anthropic 两协议适配器（现 367 行）；**改造一处**：移除对 `./logger` 的直接 `import { logEvent }`（App.ts:106-131 等埋点），改为构造时注入 `onLog?: (level, event, detail) => void` 钩子——共享库不得依赖宿主日志设施 |
| `chat-controller.ts` | 新建 | 轮次编排控制器：`createChatController(deps)`，deps 注入 `listTools`/`callTool`/`llmConfigGetter`/`onUiMessage`/`onEvent`/`onHistoryChange` 等；封装 history、AbortController、send/handoff 入口、错误分型（AgentAbortError 语义）。**P1 的智能体状态（activeAgentId、profile 组装调用点、切换提示钩子）在此模块增量** |
| 测试 | 迁 + 新增 | `agent-loop.test.ts`、`llm-client.test.ts` 随迁；新增 `chat-controller.test.ts`（依赖注入桩验证编排与错误分型） |

**边界红线（共享库不得引入的依赖）**：`chrome.*`、`logger.ts`/`trace-context.ts`（宿主侧埋点经注入）、Vue（controller 是纯逻辑，不含响应式；宿主用 `ref` 承接回调）。埋点由宿主在注入的 `onLog` 钩子里接 `logEvent`，traceId 语义保持宿主侧生成。

**消费方式（对齐现有工程约定）**：

- 包名 `webmcp-agent-chat-core`（对齐仓库现有无 scope 命名：`webmcp-chrome-extension`/`webmcp-extension-relay`/`webmcp-html-app`），进 `packages/*`（pnpm-workspace 已覆盖，无需改 yaml；无新外部依赖，catalog 不动）；
- chrome-extension `package.json` 增 `"webmcp-agent-chat-core": "workspace:*"`；side-panel 以 `import { runAgentLoop, createChatController, createLlmClient } from 'webmcp-agent-chat-core'` 消费；
- **产物策略：TS 源码直出**（`exports` 指向 `src/index.ts`），由 chrome-extension 的 vite-plus pack 打进各自 IIFE——避免为 lib 单独维护构建产物链，也符合 C3（IIFE 自包含）约束；若后续 relay/Node 宿主需要独立产物，再补 `tsc -b` 或 vp pack dist 出口；
- 三闸门：新包自带 `tsconfig.check.json` + vitest；根 typecheck 的 project 参照现有包接入方式同步。

## 3. old vs new 结构对照

```
旧（App.ts 505 行，全平铺）
App.ts
├─ chat 编排：runTurn/applyEvent/send/handleHandoff/history/chatAbort   ← 与页面无关却膨胀 App
├─ relay 消费：applyRelayStatuses/diff 日志/invokeLogs/runningCount      ← 四端共享逻辑长在根组件
├─ 数据源操作：toggleRelayTab/resetRelaySelection                        ← 数据源页专属却在上层
├─ 设置页日志管理：logCount/hint/export/clear/watch                       ← 设置页专属却在上层
└─ 真全局：路由/锁/生命周期/refreshTools/terminate

新（App.ts ≈300-330 行，纯编排；对话领域入共享库）
App.ts（状态与编排）
├─ 全局状态：activeTab/locked/messages/settings/connected/toolsCount
├─ 生命周期：pageTools/relayStatusClient 建连订阅清理（C2）
├─ 编排接线：chatController = createChatController(deps)；relayStore = createRelayStatusStore(...)
└─ terminate 分派
packages/webmcp-agent-chat-core（新公共共享库，workspace:* 导入使用）
├─ agent-loop.ts（迁入，零改动）
├─ llm-client.ts（迁入，logger 改注入钩子）
├─ chat-controller.ts（新建编排控制器 + P1 智能体状态落点）
└─ 自带 tsconfig/vitest，可被任意宿主复用
relay-status-store.ts（新，side-panel 内非 UI 可单测）
└─ statuses/selection/invokeLogs/runningCount/terminated + diff 日志 + dispose
页面（自持页面级逻辑）
├─ DataSourcePage：+ toggleTab/resetSelection 直接执行（删两个 emits）
├─ SettingsPage：+ 日志管理自持 + watch(active) 刷新（删 log props）
└─ DebugPage / RelayPage / ChatPage：不变（已是目标形态）
panel-client.ts：+ toPanelSettings 导出
```

## 4. 迁移顺序与验证（建议按依赖排序，四步各自可通过三闸门）

1. **Step 1（无依赖，先行）**：A5 `toPanelSettings` → panel-client；A3/A4 设置页日志管理下沉 + watch 迁移。纯搬运，`pnpm test` 现有用例不动。
2. **Step 2**：A1/A2 数据源操作下沉 DataSourcePage（删 emits，App 删两函数）。注意保留 App onMounted 的初始 `reset-selection`（全局初始化语义）。
3. **Step 3**：B2 抽 `relay-status-store.ts`（含单测：diff 日志、runningCount、terminated 复位）。App 改为消费 store。
4. **Step 4**：建共享库 `packages/webmcp-agent-chat-core`——迁 `agent-loop.ts`/`llm-client.ts`（llm-client 埋点改 `onLog` 注入）+ 新建 `chat-controller.ts` + 测试随迁；chrome-extension 加 `workspace:*` 依赖、side-panel 改 import、删除 App.ts 内迁出代码改接线（含单测：controller 依赖注入、runTurn 错误分型、applyEvent 痕迹组装）。此步完成后 P1 的智能体选择器/切换提示直接在共享库 controller + ChatPage 上增量。

每步后跑三闸门（typecheck / lint / vitest run，走绝对路径 node）；扩展产物行为验证（侧栏手工冒烟：五页签切换、执行锁、设置保存、数据源勾选）在 Step 2/4 后各做一轮。**注意**：Step 1–3 为 side-panel 内部调整，Step 4 涉及新包接入与 IIFE 打包验证（vp pack 后确认共享库源码被正确打进 side-panel 产物），需用户手动跑 `pnpm build` 复核产物。

## 5. 风险与注意

- **A1/A2 下沉后的日志归属**：`logEvent('relay','relay_selection_toggle')` 的 category 是否随迁改 `datasource`——建议随迁（与 DataSourcePage 现有 `datasource` category 一致，DataSourcePage.ts:124），日志检索口径统一。
- **B1 共享库边界**：`llm-client.ts` 现直接 import `./logger`（同目录埋点），迁库必须改为 `onLog` 注入，否则共享库反向依赖宿主设施；`trace-context.ts` 的 traceId 生成同样留宿主侧。controller 不含 Vue 响应式，deps 中 settings/selection 一律 getter 注入，history 变更经 `onHistoryChange` 回调由 App 用 `ref` 承接。
- **B1 打包验证**：workspace 依赖走 TS 源码直出（`exports` → `src/index.ts`），Step 4 后需 `vp pack` 实测 side-panel IIFE 是否正确内联共享库源码（vite 对 node_modules symlink 下 TS 源的解析）；若有解析问题，备选方案是 lib 出 `dist` ESM（`tsc -b`）+ 消费方引用 dist。
- **测试随迁的路径修正**：`agent-loop.test.ts`/`llm-client.test.ts` 迁入新包后，相对 import 路径与 vitest 环境配置（纯逻辑用 node 环境即可）按新包结构修正。
- **C3 `pushUiMessage` 归属**：暂留 App（三类调用方跨页）；若 P1 后对话消息域继续膨胀，可再评估并入 chat-controller 的回调参数。
- **不动 `panel-client.test.ts` 既有桩约定**：toPanelSettings 为纯函数导出，不触碰 chrome.storage 桩。
- 本分析只做**归属调整**，不改任何行为语义（无功能增删）；P1 功能（智能体选择器等）在调整完成后叠加，避免行为变更与结构变更混在一个 diff。

## 6. 执行状态（2026-09-12 更新）

- ✅ **Step 1**：SettingsPage 自管日志块（导出/清空/计数），App 只留 save emit。
- ✅ **Step 2**：DataSourcePage 自管 toggle/reset（内部函数 + sendRequest + logEvent(datasource)），App 删两函数。
- ✅ **Step 3**：新建 relay-status-store.ts + 7 单测；App 消费 store（locked/phaseLabel/terminate 全走 store）；
  关键修复：runningCount watch 加 flush:sync 规避 Vue 同 tick 双写合并导致 terminated 卡 true。
- ✅ **Step 4**：新建共享库 packages/webmcp-agent-chat-core（agent-loop / llm-client(改 onLog 注入) / chat-controller / barrel）
  + 3 测试文件 41 用例；side-panel 删除迁出文件，App.ts 改 createChatController 接线；
  chrome-extension 加 workspace:* 依赖。
- 三闸门最终状态：两包 typecheck ✓ / eslint ✓；共享库 vitest 41/41 ✓；chrome-extension vitest 12 文件 / 162 测试 ✓
  （中途 4 文件收集失败系 node_modules 安装不完整：domutils 缺 stringify.js + vue 缺 @vue/compiler-dom，
  用户手动 pnpm install --force 修复后全绿）。
- ⏳ 待办：用户手动 pnpm build（vp pack）复核共享库源码打进 side-panel IIFE 产物 + 扩展手工冒烟。
