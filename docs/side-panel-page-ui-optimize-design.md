# 侧边栏页内 UI 优化方案：数据源 / A2A / 设置

> **范围**：三个页面**页面内部**的 UI（区别于上一轮的全局布局与主题方案 `side-panel-layout-ui-theme-design.md`）
> **方法**：逐行分析真实组件源码（`pages/*.ts` + `components/{datasource,a2a,settings}/*.ts`），问题清单全部带行号证据；"已验证"= 代码实证，"推断"= 有代码依据但需运行确认
> **配套预览**：`docs/theme-preview/index.html`（三个页面已更新为优化后形态，类名与提案一一对应）
> **日期**：2026-09-13

---

## 1. 三页现状结构（基于源码还原）

```
数据源页 DataSourcePage（view/edit 互斥）
├─ view  → DataSourceSummary（只读状态表）+「调整数据源」按钮行        DataSourcePage.ts:44-58
└─ edit  → SubPageFrame「数据源选择」子页面
           ├─ DataSourcePicker（勾选/重置，即点即生效）               DataSourcePage.ts:59-72
           └─ ConnectionActions（webmcp/relay 连接刷新）              ConnectionActions.ts:37-66

A2A 页 A2aPage（list/add/edit 三态）
├─ list → 说明灰字 ×3 + 目标选择器 + A2aBindingList 卡片列表 +「新增绑定」  A2aAgentsSection.ts:165-215
├─ add  → SubPageFrame + A2aBindingForm(mode=add)                       A2aAgentsSection.ts:120-136
└─ edit → SubPageFrame + A2aBindingForm(mode=edit)                      A2aAgentsSection.ts:139-162

设置页 SettingsPage（view/edit 互斥）
├─ view → SettingsSummary（只读摘要）+「编辑配置」按钮行 + 日志区块      SettingsPage.ts:93-107
└─ edit → SubPageFrame + SettingsForm（草稿表单，9 字段直排）            SettingsForm.ts:182-221
```

三页的**骨架范式一致**（只读列表 + 子页面编辑），这是好基础；问题集中在**页内信息层级、操作区布局、反馈与确认**。

---

## 2. 数据源页问题清单（D 系列）

| # | 问题 | 证据 | 定性 |
| --- | --- | --- | --- |
| D1 | **view 态看不出哪些标签页被选中**。列表项只有「连接状态」徽章，但 connected ≠ selected；"已选 N / M"只存在于统计行文字里 | `DataSourceSummary.ts:51-65`（li 仅 title + 状态徽章，未渲染 `status.selected`） | 已验证 |
| D2 | view / edit 两态列表**排序不一致**：Summary 按 tabId 升序，Picker 选中项在前 → 切换编辑态时顺序跳变，空间记忆断裂 | `DataSourceSummary.ts:35` vs `DataSourcePicker.ts:42-47` | 已验证 |
| D3 | 锁定提示视觉权重不足：hint 复用 `.relay-page-status`（12px 正文色），不是 warn 色 | `DataSourcePage.ts:56` | 已验证 |
| D4 | 编辑态 hint 长文案铺满：`ds.actions.hint` 48 字折 3 行，挤压操作区；按钮文案"webmcp连接刷新"中英混排无空格 | `zh-CN.ts:114-116`；`ConnectionActions.ts:40-43` | 已验证 |
| D5 | 重置按钮文案过长："重置为当前活动页签（单选）"是按钮文案，不是说明文案 | `zh-CN.ts:109`；`DataSourcePicker.ts:79-87` | 已验证 |
| D6 | 空态弱：`ds.summary.empty` / `ds.picker.empty` 均为裸灰字，与对话页 `.empty` 卡片规格不一致 | `DataSourceSummary.ts:30`、`DataSourcePicker.ts:56` | 已验证 |
| D7 | 同名标签页无法区分：仅展示 title（fallback url），无 tabId / URL 辅助行 | `DataSourceSummary.ts:55`、`DataSourcePicker.ts:73` | 已验证（多同名页签场景为推断） |
| D8 | checkbox 点击目标小：行高 ≈28px、checkbox 14px | `side-panel.html:293-300` | 已验证 |

## 3. A2A 页问题清单（A 系列）

| # | 问题 | 证据 | 定性 |
| --- | --- | --- | --- |
| A1 | **列表页顶部 4~5 行同规格灰字**：`a2a.hint`（长文案）+ "编辑目标智能体" label + select + `viewTarget` 提示 + `viewTargetNotActive` ⚠ 提示，全是 11px 灰字无层级 | `A2aAgentsSection.ts:166,168-189,190-195` | 已验证 |
| A2 | **卡片头 3 按钮溢出**：测试连通/编辑/删除 3 个按钮与 id、状态挤在 `.a2a-item-head` 一行，容器无 `flex-wrap`；3 按钮合计 ≈228px，加 id 后 320px 下必然溢出 | `A2aBindingList.ts:68-88`；`side-panel.html:190`（无 wrap） | 已验证 |
| A3 | **删除立即生效且无确认、无危险色**（普通 ghost 按钮） | `A2aBindingList.ts:83-87`；注释"删除立即生效"见 `A2aBindingList.ts:3` | 已验证 |
| A4 | meta 三行等权重：长 URL `word-break: break-all` 折多行撑高卡片；"未覆盖（默认用卡片接口地址）"占一整行 | `A2aBindingList.ts:89-94` | 已验证 |
| A5 | 连通测试结果无视觉分级：成功/失败同为 `.settings-hint` 灰字，结果常驻无法清除 | `A2aBindingList.ts:95-97` | 已验证 |
| A6 | 空态无引导："暂未绑定远程智能体"一行灰字，缺"去新增"CTA | `A2aBindingList.ts:101-103` | 已验证 |
| A7 | **表单全部用 placeholder 代替字段标签**：输入后提示消失，用户无法确认"卡片地址"与"端点覆盖"哪个是必填语义；add 模式 4 个裸 input 无分组 | `A2aBindingForm.ts:114-161` | 已验证 |
| A8 | 全局 notice（持久化失败）用 11px 小字呈现，作为失败反馈太弱 | `A2aAgentsSection.ts:110-117,196` | 已验证 |

## 4. 设置页问题清单（S 系列）

| # | 问题 | 证据 | 定性 |
| --- | --- | --- | --- |
| S1 | **摘要 8~9 行同规格无分组**：连接鉴权 / 生成参数 / 行为混排；且 `API Key`/`Base URL`/`API Path`/`Max Tokens` 标签是硬编码英文（未经 i18n） | `SettingsSummary.ts:42,44,46,49` | 已验证 |
| S2 | 日志区块（操作类）与配置摘要（信息类）平铺混排，仅一条 border-top 分隔 | `SettingsPage.ts:76-87,95-106` | 已验证 |
| S3 | **清空日志无确认**：点击立即 `clearLogs()` | `SettingsPage.ts:54-59` | 已验证 |
| S4 | dirty 提示弱且位置偏：11px warn 灰字在摘要末尾；表单内还有一处重复 | `SettingsSummary.ts:56-58`；`SettingsForm.ts:217-218` | 已验证 |
| S5 | 摘要长值（Base URL / API Path）`word-break: break-all` 折行撑高 | `side-panel.html:147`；`SettingsSummary.ts:44,46` | 已验证 |
| S6 | 编辑态 9 字段直排无分组，systemPrompt textarea（rows=4）居中，长表单滚动无锚点 | `SettingsForm.ts:183-205` | 已验证 |
| S7 | "编辑配置"按钮孤悬一行，与摘要卡片割裂（多占 ≈44px） | `SettingsPage.ts:96-105` | 已验证 |

## 5. 跨页共性问题（C 系列）

| # | 问题 | 涉及 |
| --- | --- | --- |
| C1 | **反馈全部走 `.settings-hint` 文本**，ok/err/warn 只差一个 class 但多数没用上（测试结果、logHint、notice） | A5 / A8 / S4 |
| C2 | **高危操作无防护**：A2A 删除（立即整表替换）、清空日志（立即清 DB） | A3 / S3 |
| C3 | **空态三处三样**：对话页卡片式、数据源/A2A 裸灰字 | D6 / A6 |
| C4 | 长文案 hint 直接铺陈（48 字 / 两行），挤压内容区 | D4 / A1 |

---

## 6. 优化方案

> 每项标注改动类型：**(css)** = 纯样式可达，零 `.ts` 改动；**(i18n)** = 仅文案值；**(组件小改)** = 在对应 `.ts` 的 `h()` 结构上加类名/调整节点（不触碰数据流、props/emits 契约与任何业务逻辑）。
> 预览沙盘中三个页面已按本方案更新（新类定义在 `theme-preview/styles/panel-optimize.css`，提案层独立文件，可整体取舍）。

### 6.1 数据源页

| # | 优化 | 改动类型 |
| --- | --- | --- |
| D1 | 列表项选中标识：选中项 accent 状态槽 + 软底 +「已选中」徽章（`status.selected` 数据已存在，仅未渲染） | 组件小改（`DataSourceSummary.ts` li 加 class + 徽章） |
| D2 | 两态排序统一为「选中在前，其余按 tabId」（对齐 Picker 现状） | 组件小改（Summary sort 一行） |
| D3 | 锁定提示换 `settings-hint-warn` | 组件小改（class 名一行） |
| D4 | `ds.actions.hint` 缩短为一句 + 按钮文案改「webmcp 刷新 / relay 刷新」（中英间加空格） | i18n |
| D5 | 重置按钮文案精简为「重置选择」，说明语义并入 hint | i18n |
| D6 | 空态统一为 `.empty` 卡片规格（虚线框 + 引导文案） | 组件小改（class 名） |
| D7 | 同名页签区分：title 下加 URL 次行（`.relay-source-url`，mono 10px 单行省略） | 组件小改 + css |
| D8 | 行高提到 36px、checkbox 15px（上轮主题方案已含，此处确认不回退） | css |

### 6.2 A2A 页

| # | 优化 | 改动类型 |
| --- | --- | --- |
| A1 | 顶部收敛为一条**目标工具条** `.a2a-target-bar`（mono 标签 + select + 当前目标徽章）；`a2a.hint` 精简为一行或移入空态 | 组件小改 + i18n |
| A2 | **操作区独立成行** `.a2a-item-actions`（右对齐 + 虚线上边线），卡片头只留 id + 状态徽章；CSS 兜底：`.a2a-item-head` 加 `flex-wrap`（零 `.ts` 可先止血） | 组件小改 + css 兜底 |
| A3 | 删除钮 `danger-ghost` 红描边 + **两步确认**：首次点击变「确认删除？」（3s 内再点生效，超时还原）——页内 inline confirm，不引入弹窗组件；删除逻辑本身不动 | 组件小改（本地 confirm ref） |
| A4 | meta 徽章化：「未覆盖」→ 灰徽章 `.a2a-meta-badge-muted`；Token 已配置 → ok 徽章；URL 行单行省略 + `title` 悬停看全量 | 组件小改 + css |
| A5 | 测试结果分级：`.a2a-test-result-ok/-err`（左缘状态条 + 色字）；进行中沿用「测试中…」按钮态 | 组件小改（记录 kind） |
| A6 | 空态卡片 + 内嵌「新增绑定」CTA | 组件小改 |
| A7 | 表单字段补 label（卡片地址 / 端点覆盖（可选）/ Bearer Token（可选））；edit 的 id 行加「不可修改」标注 | 组件小改 + i18n |
| A8 | notice 样式升级为 warn 卡片（复用 `.chat-agent-confirm` 规格：边框 + 左缘状态条） | css + class |

### 6.3 设置页

| # | 优化 | 改动类型 |
| --- | --- | --- |
| S1 | 摘要分三组（**连接与鉴权** / **生成参数** / **行为**），mono 组标题 + 发丝分隔；英文标签纳入 i18n | 组件小改 + i18n |
| S7 | 摘要卡片化 `.settings-card`（左缘 accent 状态条），「编辑配置」移入卡片标题行右侧 —— 省一整行 | 组件小改 |
| S4 | dirty 提示上移到卡片头下方（第一眼可见） | 组件小改 |
| S5 | 摘要长值单行省略 + `title` | css |
| S2 | 日志区降级为页脚折叠 `<details>`（默认收起，摘要行显示条数） | 组件小改 |
| S3 | 清空日志两步确认（同 A3 模式） | 组件小改 |
| S6 | 编辑表单同 S1 分组（三组 fieldset 语义，API Key 保持首字段） | 组件小改 |

### 6.4 两步确认交互口径（A3 / S3 共用，需确认）

```
常态        [删除]           点击 → 进入确认态（3s 倒计时）
确认态      [确认删除？]      再点 → 执行原删除逻辑；点击别处 / 3s 超时 → 还原常态
```

- 不引入弹窗组件、不阻塞其余操作；超时自动还原避免"卡在确认态"。
- **数据层零改动**：仍是原 `emit('remove')` / `clearLogs()`，只是点击次数 1 → 2。此为交互语义微调，按 `design_rules §7.3` 属 **L2（execute 内部逻辑调整）**，需你确认。

---

## 7. 方案分级与评估

| 方案 | 内容 | 成本（人天） |
| --- | --- | --- |
| **方案一 · P0 止血包** | A2 flex-wrap 兜底（css）、A3 danger 色（css，`:last-of-type` 兜底）、D3 warn class、D4/D5 i18n 文案、C3 空态 class 统一 | 开发 0.25 + 自测 0.25 = **0.5** |
| **方案二 · P0+P1（推荐）** | 方案一 + 6.2/6.3 全部结构优化（工具条、操作行、徽章化、结果分级、表单 label、摘要分组卡片化、日志折叠、两步确认） | 开发 2.0 + 自测 0.75 + 三档宽度联调 0.25 = **3.0** |
| **方案三 · 全量** | 方案二 + P2 打磨：连通测试 loading 动画、Token 显示/隐藏切换、摘要行 hover 快捷编辑、logHint 自动消退 | 开发 3.0 + 自测 1.0 = **4.0** |

**六维评估（口径同上轮文档 §4.5，UI 任务适配版）**：

| 维度 | 方案一 | 方案二（推荐） | 方案三 |
| --- | --- | --- | --- |
| 扩展性（新卡片/字段沿用成本） | 中（只修急症，卡片范式未变） | **高**（操作行/徽章/分组成为可复用范式） | 高 |
| 稳定性（回归风险） | **高**（几乎全 CSS/i18n） | 高（组件小改均不触数据流；两步确认已划为 L2 待确认） | 中（新增交互态面变大） |
| 可维护性 | 中 | **高**（8 处重复选择器已在主题层收敛，本层新增类全部集中 panel-optimize） | 中偏高（P2 增加状态面） |
| 上下游依赖影响 | **低** | 低（6 个组件文件内部，无契约变化） | 低 |
| 收益 | 治标：320px 溢出止血、高危操作有色 | 治本：信息层级、反馈、防护、空态、表单可用性全补齐；**A2 溢出、A3/S3 无确认、A7 无标签、D1 无选中标识四个硬伤全消** | 方案二 + 观感细节 |
| 成本 | 0.5 | 3.0 | 4.0 |

**推荐方案二**：P1 各项均为"页内小改"，与数据流无关；硬伤（A2 溢出属**可用性缺陷**，A3/S3 属**误操作风险**）一次清零。

---

## 8. 落地清单（方案二）

| # | 文件 | 改动 | 类型 |
| --- | --- | --- | --- |
| 1 | `side-panel/side-panel.html` | 追加 `panel-optimize.css` 对应规则段（约 190 行）+ `.a2a-item-head` 补 `flex-wrap` | css |
| 2 | `side-panel/i18n/zh-CN.ts` + `en-US.ts` | D4/D5 文案、S1 组标题新键、A7 字段标签新键 | i18n |
| 3 | `components/datasource/DataSourceSummary.ts` | D1 选中徽章与状态槽、D2 排序、D7 URL 次行、D6 空态 class | 组件小改 |
| 4 | `components/datasource/DataSourcePicker.ts` | D5 按钮文案（i18n 引用不变则零改）、D6 空态 | 组件小改/零改 |
| 5 | `pages/DataSourcePage.ts` | D3 锁定提示 class | 组件小改（一行） |
| 6 | `components/datasource/ConnectionActions.ts` | D4 hint 文案引用（i18n 值变更则零改） | 零改/微改 |
| 7 | `components/A2aAgentsSection.ts` | A1 目标工具条、A8 notice class | 组件小改 |
| 8 | `components/a2a/A2aBindingList.ts` | A2 操作行、A3 两步确认、A4 徽章、A5 分级、A6 空态 CTA | 组件小改（最多） |
| 9 | `components/a2a/A2aBindingForm.ts` | A7 字段 label | 组件小改 |
| 10 | `pages/SettingsPage.ts` | S2 日志折叠、S3 两步确认 | 组件小改 |
| 11 | `components/settings/SettingsSummary.ts` | S1 分组、S7 卡片化、S4 dirty 上移、S1 英文标签 i18n | 组件小改 |
| 12 | `components/settings/SettingsForm.ts` | S6 分组 | 组件小改 |

预估：`<style>` 再增 ≈190 行（叠加在上轮方案之上，`side-panel.html` 总行数问题仍按上轮文档 6.1 处置）。

## 9. 风险与验收

| 风险 | 缓解 |
| --- | --- |
| 两步确认改变操作习惯 | 已列为 L2 待确认项；超时自动还原，误锁概率低 |
| 摘要分组需要新增 i18n 键（组标题 ×3 + 字段标签 ×4） | 键名跟随 `settings.summary.*` 前缀，en-US 同步 |
| A2A 操作行右对齐在 480px 宽时按钮远离内容 | 行内 `justify-content: flex-end` 在宽容器下仍贴卡片右缘，符合"操作在右上"惯例 |
| 日志折叠默认收起后导出入口变深 | summary 行即显示条数；导出属低频排障动作 |

**验收**：① 320px 下 A2A 卡片头/操作行零溢出（本轮核心验收项）；② 全部 `.ts` 改动不触碰 props/emits 契约与业务函数（除两步确认的本地 ref）；③ 三闸门（tsc / eslint / vitest）通过；④ 与主题方案叠加后 4 套主题下新元素对比度仍达标（新类全部复用已实测令牌，无需重测；`relay-badge-selected` 用 accent/accent-soft 组合，已过）。

## 10. 待确认

1. 方案分级：一（0.5 人天止血）／**二（3.0 人天，推荐）**／三（4.0 人天全量）。
2. 两步确认交互（A3/S3）：接受 inline 两步 / 仅改 danger 色不做确认 / 维持现状。
3. 摘要分组命名：「连接与鉴权 / 生成参数 / 行为」是否合适。
4. `a2a.hint` 精简幅度：保留一句 / 完全移除（空态与工具条已自解释）。
