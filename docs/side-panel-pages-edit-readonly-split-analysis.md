# 侧栏三页「编辑态 / 只读态」拆分分析

> **状态更新（2026-09-13）**：方案 A 已确认并落地。决策点结论：① 方案 A；② 未保存离开仅提示 + 保存/取消按钮；③ A2A 行编辑 token 随「确认」一并保存；④ SettingsSummary 展示 apiKey 脱敏掩码。落地结构与本文 §3/§4 一致（components/settings|a2a|datasource 三组子目录），验证 vitest 176/176 + tsc + eslint 全绿。

> 范围：`packages/webmcp-chrome-extension/main-extension/side-panel` 下
> 数据源设置（DataSourcePage）、远程智能体 A2A（A2aPage + A2aAgentsSection）、设置（SettingsPage + SettingsPanel）。
> 目标：拆分页面功能，把「表单编辑状态」与「只读状态展示」分离。
> 性质：分析 + 方案提案（未改代码），供审批后进入改造。

---

## 1. 三页功能盘点（已验证，行号为当前源码）

### 1.1 数据源设置 DataSourcePage.ts

| 功能块 | 位置 | 状态类型 | 说明 |
| --- | --- | --- | --- |
| 状态摘要 | `renderStatusSummary` L42-51 | **只读展示** | 已连接数 / 已选数统计，数据源为 SW 推送快照 |
| 数据源选择列表 | `renderSourcePicker` L54-107 | **编辑态 + 只读混排** | checkbox 勾选（编辑）与每行状态徽章（只读）同一行；「重置为活动页签」按钮（操作） |
| 勾选/重置动作 | `toggleTab` L113-120、`resetSelection` L123-126 | 操作（即时生效） | 直接 `sendRequest('set-selection'/'reset-selection')`，无草稿、无确认 |
| 连接刷新 | `renderConnectionActions` L147-179 | 操作态 | webmcp/relay 两按钮，fire-and-forget，本地 `reconnecting` ref 仅做 1s 节流（L131-145） |

特点：**没有本地表单草稿态**。checkbox 即点即生效（选择集合语义，非表单），真实状态由 SW 推送回灌 —— 本页的「编辑」本质是操作指令，不是表单编辑。

### 1.2 远程智能体 A2A（A2aPage.ts + components/A2aAgentsSection.ts）

A2aPage 是薄壳（L46-62 纯透传），全部逻辑在 A2aAgentsSection：

| 功能块 | 位置 | 状态类型 | 说明 |
| --- | --- | --- | --- |
| 页头说明文案 | Section L228-232 | 只读展示 | 静态说明 |
| 编辑目标选择器 | Section L235-257 | 编辑态（即时生效） | select 切 `targetAgentId`；⚠ 非激活智能体提示（L254-256，只读） |
| 绑定列表项 | Section L183-226 | **编辑态 + 只读混排** | 启停 checkbox（编辑）、id 展示（只读）、cardUrl / endpointOverride / token 输入（**onChange 直写持久化**，L201-223）、测试连通按钮 + 测试结果文案（只读） |
| 新增绑定表单 | Section L266-304 | **标准草稿编辑态** | 本地 ref 草稿 `newId/newCardUrl/newEndpoint/newToken`（L44-48）+ 本地校验 `formError` + 6s 自动清除的 `formSuccess`（L125-135），确认后才 emit |
| 全局 notice | App 注入 `notice` | 只读展示 | App 级持久化/同步失败提示（App.ts L110-129） |

数据归属（已验证）：`a2aAgents` 持久化在 profile（`emit('update:a2aAgents')` 整表替换 → App.ts L146-155 `profileStore.updateAgentA2aAgents`）；token 存 `chrome.storage.local` 的 a2aTokens（App.ts L157-167，token onChange 保存是防写入风暴的刻意设计，见 Section L218-219 注释）。

### 1.3 设置 SettingsPage.ts + components/SettingsPanel.ts

| 功能块 | 位置 | 状态类型 | 说明 |
| --- | --- | --- | --- |
| 日志区块管理 | SettingsPage L26-61 | 操作态 + 只读展示 | 页面自持 `logCountText/logHint`，导出/清空动作，active 时刷新 |
| LLM 表单本体 | SettingsPanel L131-164 | **就地编辑，无草稿态** | `props.settings` 是 App 的 live reactive 对象，onInput 直接改字段（L36-38、L51-53、L72-75 等），「保存」按钮仅触发 `persistSettings` 落盘（App.ts L613-618） |
| 条件字段 | SettingsPanel L141 | 编辑态 | maxTokens 仅 anthropic 协议显示 |
| 安全提示 / 日志计数 / hint | SettingsPanel L157-163 | 只读展示 | 静态提示 + 日志操作反馈 |

**核心问题（已验证）**：SettingsPanel 的编辑**没有草稿与已保存之分** ——
- 输入即改 App 内存 `settings`，不点「保存」也已影响运行中逻辑（发起对话会读到未保存值）；
- 无 dirty 标记、无取消/还原入口；
- 「只读展示当前生效配置」的视角不存在（想确认当前生效值只能进输入框看 value）。

---

## 2. 诊断结论：编辑态 / 只读态的混合点

| # | 位置 | 问题 | 严重度 |
| --- | --- | --- | --- |
| P1 | SettingsPanel 全表单 | 编辑直写 live settings，草稿态缺失；未保存即生效；无 dirty/取消 | 高 |
| P2 | A2aAgentsSection 列表项 | cardUrl/endpoint/token onChange 直写持久化，无行级编辑态与只读卡片之分 | 高 |
| P3 | A2aAgentsSection 列表项 | 启停状态、测试结果（只读）与编辑输入混排同一行 | 中 |
| P4 | DataSourcePage 选择列表 | 状态徽章（只读）与 checkbox（编辑）混排；但「即时生效」是选择语义而非表单语义，混排影响小 | 低 |
| P5 | 三页共性 | 展示型信息（摘要/结果/hint/notice）散落在编辑组件内部，无独立只读展示组件 | 中 |

---

## 3. 拆分方案（A / B）

### 方案 A：组件职责拆分 —— 展示组件与编辑组件分离（推荐）

页面仍是单视图，但每个功能域拆成「只读展示组件」与「编辑组件」两类，状态归属清晰：

```
pages/
  DataSourcePage.ts        # 组装层
  A2aPage.ts               # 组装层（保持薄壳）
  SettingsPage.ts          # 组装层 + 日志区块（不变）
components/
  datasource/
    DataSourceSummary.ts   # 只读：连接统计 + 各 tab 状态表（含徽章）
    DataSourcePicker.ts    # 编辑：checkbox 选择 + 重置（即时生效语义保留）
    ConnectionActions.ts   # 操作：连接刷新两按钮（可并入 Picker 或独立）
  a2a/
    A2aBindingList.ts      # 只读卡片：id / 卡片地址 / 端点 / 启停态 / 测试结果
    A2aBindingEditor.ts    # 编辑：行内「编辑」进入表单态，确认后整条提交
    A2aAddForm.ts          # 编辑：现有新增表单（已是标准草稿态，原样迁出）
  settings/
    SettingsSummary.ts     # 只读：当前生效配置（协议/BaseURL/模型，apiKey 脱敏掩码）
    SettingsForm.ts        # 编辑：草稿副本 + dirty 跟踪 + 保存/取消
```

SettingsForm 草稿语义（P1 的解法，**推断设计，需确认**）：
- 进入页面（或 `active` 翻真）时从 `props.settings` 快照出本地草稿 ref；
- onInput 只改草稿；`dirty = computed(草稿 ≠ 快照)`，dirty 时页签切换可复用现有 `locked` 守卫思路提示；
- 「保存」emit `save(draft)` → App `persistSettings` 落盘后草稿基线刷新；「取消/还原」丢弃草稿回到基线。

A2A 行编辑语义（P2/P3 的解法）：
- 默认渲染只读卡片（id、卡片地址、端点覆盖、启停徽章、最近测试结果）；
- 点「编辑」→ 行内切换为表单态（cardUrl/endpoint/token 草稿 + 确认/取消），确认才走 `update:a2aAgents` / `save:token`；
- 启停 checkbox 与删除保留在卡片头部（即时生效操作，语义与「编辑表单」分离）；
- token 仍保持 onChange/确认时一次性保存（保留防写入风暴设计，Section L218-219）。

DataSourcePage（P4 的解法）：仅做组件拆分，状态徽章移入只读 Summary，Picker 列表只保留勾选交互；即时生效语义不变（选择集操作不是表单）。

**优点**：改动粒度可控、逐块迁移、每步可过三闸门；展示组件天然可复用（如 SettingsSummary 可给 ChatPage「查看提示词」类场景）。**缺点**：页面视觉上仍是「全编辑」，只读视角靠组件分区呈现。

### 方案 B：页级「查看 / 编辑」双模式切换

每页两种渲染形态：view 模式全部只读展示（含配置详情），点「编辑」才进入表单态；编辑中 dirty 时锁页签（复用 `setTab` 守卫 App.ts L209-212）。

**优点**：编辑态与只读态彻底物理隔离，符合「先看后改」动线。**缺点**：需要页级模式状态 + 草稿快照/还原 + 切换守卫三套机制，A2A/DataSource 的「即时生效操作」（勾选、启停、删除、测试连通）在 view 模式下的去留需要逐个决策，改动面与回归风险显著大于方案 A。

### 推荐

**方案 A**。理由：三页中真正缺草稿态的只有 SettingsPanel（P1）和 A2A 行编辑（P2），DataSource 本就是「快照只读 + 即时操作」语义，硬套双模式反而扭曲交互；方案 A 用同一套「只读展示组件 + 编辑组件」约定覆盖三页，且能增量落地。

---

## 4. 落地步骤（方案 A，每步独立可验证）

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| S1 | SettingsPanel → SettingsForm（草稿+dirty+取消）+ SettingsSummary；SettingsPage 接线 | typecheck + 既有单测 + 手测「不保存不生效」 |
| S2 | A2aAgentsSection 拆 A2aBindingList（只读卡片）/ A2aBindingEditor（行编辑）/ A2aAddForm（迁出）；A2aPage、App props/emits 相应对齐 | typecheck + panel-client/tab-source 既有单测回归 |
| S3 | DataSourcePage 拆 Summary / Picker（+ConnectionActions 归位） | typecheck + relay-status-store 单测回归 |
| S4 | 展示类 CSS 类名归位（settings-hint / relay-badge 等随组件迁移），全量三闸门 | vitest / tsc -p / eslint（绝对路径调用） |

约束遵循项目规则：不跑 dev/build，改完只做只读校验；App.ts 改动逐条顺序 Edit 并复核（防并发回写）。

---

## 5. 待确认决策点

1. 方案 A vs 方案 B（推荐 A）。
2. SettingsForm 草稿的「未保存离开」策略：阻断切页签（复用 locked）还是仅提示？（推荐仅提示 + 保存/取消按钮，避免与执行锁语义混淆）
3. A2A 行编辑的 token：编辑态内随「确认」一并保存，还是维持现状 onChange 保存？（推荐随确认保存，简化心智；写入风暴防护已有先例注释可沿用）
4. SettingsSummary 是否需要展示 apiKey 脱敏掩码（如 `sk-***abc`）？（推荐展示，给只读视角闭环）
