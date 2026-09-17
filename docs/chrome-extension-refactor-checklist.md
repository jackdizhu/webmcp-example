# 待改造文件清单：webmcp-chrome-extension

> **【状态更新 2026-09-17】** 第一部分「h() → SFC 改造候选清单」已以 **TSX** 方式**全量完成**（22 个组件/页面 → `.tsx`，走 oxc/tsconfig 零插件路径而非 SFC 路径，三闸门全绿），该部分全部关闭；§二起的复杂度问题清单仍有效，但其中已随迁移顺手修复的条目以代码现状为准。审查依据更新为 `rules/coding-style.md` §3（TSX 规范，v1.6.0）。

> 审查依据：`rules/coding-style.md` §3（SFC 规范）与 §2.1（通用代码质量规范）。
> 审查日期：2026-09-16（基于 dev-base 工作区快照，行号为当日快照行号）。
> 范围：`packages/webmcp-chrome-extension` 全部 `.ts` 源文件（core/ + main-extension/ + shell/ + e2e-extension/，不含 node_modules/dist）。

## 使用说明

- **h() → SFC**：§3 明确「存量 h() 并存、渐进迁移、不强迁」，以下为改造候选清单，非强制项。迁移约束：块顺序固定 `template` → `script`、**禁 `<style>` 块**（样式归 `style/` 目录，按页面/组件拆分）、SFC 组件放 `components/sfc/`。**（已关闭：2026-09-17 实际以 TSX 全量迁移完成，见顶部状态更新）**
- **复杂度**：§2.1 硬阈值——单文件 ≤ 800 行；函数体 ≤ 50 行；圈复杂度 ≤ 10；嵌套 ≤ 3 层；参数 ≤ 3；默认值回退用 `??` 不用 `||`；魔法数字提取具名常量；禁空 catch / 吞异常。

## 一、h() → SFC 改造候选清单（21 个文件，均在 main-extension/side-panel/）

### 优先级 P1（体量大 / 职责混，迁移时建议顺手拆分）

| 文件 | 行数 | h() 迁移附带问题（§2.1） |
|---|---|---|
| side-panel/App.ts | 631 | setup() 约 565 行（65–629），超 50 行阈值 11 倍；applyEvent:255–284 嵌套 4 层；tool_result/tool_error 两分支（255–268 / 269–284）逐字重复；onMounted（433–533，约 100 行）混 i18n/日志/设置/档案/A2A/桥接 6 类初始化；状态 + agent 编排 + 持久化协调 + UI 事件分发 + 渲染树组装 5 职责混一文件；:122 `6000` 通知清除魔法数字；:179 硬编码 `'a2a__'`/`'__send_task'`（core 已导出常量未用）；:225–227 catch 静默置零无日志 |
| side-panel/pages/DebugPage.ts | 329 | renderForm:204–270（67 行）、execute:102–153（52 行）超长；成功/失败 run 构造 116–125 与 135–142 重复 |
| side-panel/components/settings/SettingsForm.ts | 231 | 渲染树嵌套深，可整体 SFC 化 |
| side-panel/components/a2a/A2aBindingForm.ts | 188 | 编辑/新建双形态分支嵌套深 |

### 优先级 P2（中等）

| 文件 | 行数 | 备注 |
|---|---|---|
| side-panel/pages/SettingsPage.ts | 176 | :77 `3000` 确认超时魔法数字（A2aBindingList:23 已有 CONFIRM_TIMEOUT_MS 同类常量）；:62–82 两步确认定时器与 A2aBindingList.ts:56–80 重复实现 |
| side-panel/components/A2aAgentsSection.ts | 174 | — |
| side-panel/components/a2a/A2aBindingList.ts | 168 | — |
| side-panel/components/MessageList.ts | 109 | — |
| side-panel/components/RelayStatusBar.ts | 108 | :11–17 STATE_KEY 映射与 DataSourceSummary.ts:16–22 逐字重复；:83 `status.title \|\| status.url \|\| t(...)` 应用 `??` |
| side-panel/pages/ChatPage.ts | 114 | — |
| side-panel/pages/A2aPage.ts | 105 | — |
| side-panel/components/datasource/DataSourceSummary.ts | 101 | :16–22 STATE_KEY 映射重复（见上）；:41–46 排序逻辑与 DataSourcePicker.ts:42–47 逐字重复；:77 `\|\|` 回退 |
| side-panel/components/datasource/DataSourcePicker.ts | 92 | :42–47 排序逻辑重复；:73 `\|\|` 回退 |
| side-panel/pages/RelayPage.ts | 84 | — |
| side-panel/pages/DataSourcePage.ts | 81 | — |

### 优先级 P3（小组件，低风险，适合先迁验证 SFC 链路）

| 文件 | 行数 | 备注 |
|---|---|---|
| side-panel/components/TabBar.ts | 66 | — |
| side-panel/components/datasource/ConnectionActions.ts | 69 | :32 `1000` 节流魔法数字 |
| side-panel/components/SubPageFrame.ts | 52 | — |
| side-panel/components/Composer.ts | 48 | — |
| side-panel/components/AppHeader.ts | 47 | — |

已试点：`components/sfc/PilotHello.vue`（16 行样板，DebugPage.ts:319 已挂载）。

## 二、复杂度问题清单（§2.1）

### 🔴 高严重度

| 文件 | 行数 | 问题（行号证据） |
|---|---|---|
| core/tab-source-manager.ts | **1203** | 超 800 阈值 50%；`startTabSourceManager` 428–1085 单函数 **658 行**；`createPortToolsFacade` 266–400（约 135 行）；`startRelayStatusPort` 1093–1202（约 110 行）；`ensureClient` 811–908（约 98 行）；1144–1188 onMessage 按 type 四段 if 链未查表；781–806 setTimeout 内 async IIFE 内 if+try/catch 嵌套过深；魔法数字：459 `?? 9333`、776 `1000 * 2 ** attempt, 30_000`、275 `max = 300`、287 `60_000`；:778 `reason \|\| 'unknown'` 应为 `??`；7 处以上吞异常空 catch（60–62、254–256、395–397、705–707、711–713、537–539）；89/101/351/365/928/966/1011 等大量 console 诊断输出；1039–1042 与 1013–1017 healTimers 清理逻辑重复；825–826/842–845/848–849/889–893 可选字段同步 if 模式重复 4 处；**7 类职责混一模块**（tab 生命周期编排 / page-tools 请求-响应门面 / 选择状态管理+持久化 / 状态快照聚合 / 调用日志缓冲 / 自愈重注入 / 侧栏状态端口服务） |
| core/relay-source-client.ts | **1163** | 超 43%；`activateSocket` 680–774（约 95 行）、`handleRelayMessage` 848–926（约 79 行，861–925 按 type 6 段 if 链）、`handleInvoke` 928–1000（约 73 行）、`probeEndpoint` 582–646（约 65 行）；744–767 `.catch` 内 if+try 内再 try/catch（3 层以上）；魔法数字：741 `close(4000)`、899 `close(1008)`、1018 `0.85 + Math.random() * 0.3`、209/737 `readyState === 1`、561 `port > 65535`；:897 `reason \|\| message \|\| 'unknown reason'` 应为 `??`；:194 `relayLog(level, debugEnabled, tabId, args)` 4 参数；:780 `pushToolsChanged(isRetry = false)` 布尔旗标；空 catch：487–490、541–544、606–610、709–712、762–766、898–902、1100–1102；重复：226/273 summarizeArgs 与 summarizeResult 同构、1127–1139 与 559–577 候选端点构建重复、469–493 与 520–552 定时器清理重复、754–758 与 981–985 onPortDead try/catch 重复、287 `60_000` 与 tab-source-manager 重复定义；**6 类职责混一模块**（连接状态机 / 发现握手协议 / invoke 转发 / 调用日志 / LNA 检测 / 错误码规范化） |
| core/tab-source-manager.test.ts | 1087 | 超 800 阈值 36%；15+ 用例重复「建 stub → 设 tabs → 工厂 → startTabSourceManager」样板（231–243、320–328、360–368 等几乎逐字复制），可抽公共 helper |
| core/relay-source-client.test.ts | 833 | 刚超 4%；server-hello 消息字面量重复约 13 次（143–150、174–181、205–212、245–252、331–338、368–375、393–400、470–477、501–508、529–536、575–582、759–766、806–813） |
| side-panel/App.ts | 631 | 未超 800 行但为全包最大源文件；详见 P1 表格（setup 565 行为本包最长函数、applyEvent 嵌套 4 层、分支逐字重复、5 职责混一） |

### 🟡 中严重度

| 文件 | 行数 | 问题 |
|---|---|---|
| core/builtin-tools.ts | 507 | `collectDocumentInfoInPage` 179–294（约 116 行）、`executeBuiltinTool` 437–506（约 70 行）超长；非文本标签清单 **3 份复制**（61–68 / 185–189 / 310–316）；:269 `slice(0, 200)`、`>= 50` 魔法数字；460 与 486–500 两处全空字段 entry 对象重复；451–501 for 内 try 内 if（3 层，边缘） |
| side-panel/panel-client.ts | 597 | `connectPageTools` 工厂 295–596（约 300 行）；attachBuiltinTools:52–78 与 attachInjectedTools:89–120 四个转发方法逐字重复；consumeRuntimeLastError:179–184 与 relay-status-client.ts:43–48 重复；:481 `.catch(() => {...})` 未记录错误详情；**三职责混一**（设置持久化 122–267 / 装饰器工厂 52–120 / 多页签连接管理 295–596） |
| side-panel/content-script.ts | 107 | :53、:58、:72、:95、:100、:105 共 6 处 console 直出，未收敛到日志通道 |
| side-panel/relay-status-client.ts | 210 | attachPort:104–140 按 msg.type 四连 if 分发未查表；consumeRuntimeLastError 重复（见上）；:147/:193/:199 console 残留 |

### 🟢 低严重度

| 文件 | 行数 | 问题 |
|---|---|---|
| core/page-tools-bridge.ts | 180 | 140–142 与 155–157 错误包装 respond 重复；99–103、117–124 postMessage 静默丢弃（有注释） |
| core/relay-lna-permission.ts | 71 | 47–50 catch 返回 null 无日志（有注释） |
| side-panel/pages/SettingsPage.ts | 176 | 见 P2 表格（魔法数字 + 确认定时器重复） |
| side-panel/components/datasource/ConnectionActions.ts | 69 | :32 `1000` 节流魔法数字 |
| side-panel/components/datasource/* | — | STATE_KEY 映射逐字重复 ×2（RelayStatusBar/DataSourceSummary）、排序逻辑逐字重复 ×2（DataSourcePicker/DataSourceSummary）、`status.title \|\| status.url` 共 3 处应用 `??` + 判空 |
| side-panel/a2a-host.ts | 150 | :132 硬编码 `'a2a__'`/`'__send_task'`（core 已导出 A2A_TOOL_PREFIX/A2A_SEND_TASK_SUFFIX 未用） |
| side-panel/debugger-core.ts / logger* / a2a-config-store / agent-profile-store | 105–181 | 整体干净，个别魔法数字 |

## 三、整体面结论

- **纪律项干净**：无 `any` 违规、无注释掉的死代码、无 `console.log` 字面残留（core 的 console 均为 info/warn 诊断输出，但量偏多，后续可收敛到 logger 通道）。
- **债务集中**：4 个超 800 行文件 + App.ts 巨型 setup + 5 组跨文件 DRY 重复。
- **建议改造顺序**：先按职责拆 `tab-source-manager.ts` / `relay-source-client.ts` 两个高严重度模块 → 迁 P3 小组件打通 SFC 构建链路 → P2/P1 组件渐进迁移 → 最后 App.ts 拆分 + SFC 化（配合 `side-panel-app-page-split-analysis.md` 既有分析）。
