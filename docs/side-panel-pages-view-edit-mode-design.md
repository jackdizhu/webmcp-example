# 侧栏三页「查看 / 编辑」双模式分离设计方案

> **状态更新（2026-09-13）**：已确认并落地。决策点结论：① A2A 编辑粒度 = **按智能体完整块一起编辑**
> （A2aBlockEditor 整块草稿，保存整块提交/取消整体丢弃；行级编辑器 A2aBindingEditor 已删除，
> A2aBindingList 简化为纯只读卡片）；② 启停/删除/连接刷新归 edit，测试连通留 view；
> ③ 日志区两模式常驻；④ TabBar 未保存标记本期不做。验证 vitest 176/176 + tsc + eslint 全绿。

> 背景方案 A（组件职责拆分）已落地（2026-09-13，见 side-panel-pages-edit-readonly-split-analysis.md），
> 但三页仍是**同页纵向堆叠**：设置页 = 摘要区 + 表单区；A2A 页 = 只读卡片 + 行编辑器 + 新增表单；
> 数据源页 = 状态表 + 勾选列表 + 刷新按钮。
> 本设计把每页改为「查看（view）/ 编辑（edit）」**互斥双模式**：同一时刻只渲染一种形态。
> 性质：设计方案（未改代码），含 old-vs-new 对比与待确认决策点，供审批。

---

## 1. 现状问题（混合点，已验证）

| 页面 | 现状堆叠 | 混合问题 |
| --- | --- | --- |
| 设置页 | `SettingsSummary`（只读）+ `SettingsForm`（编辑）+ 日志区 同屏纵排 | 只读摘要与编辑表单并存，视觉上无法区分「当前生效」与「草稿」两个视角 |
| A2A 页 | 只读卡片 + 被编辑行替换为编辑器 + 底部常驻「新增绑定」表单 | 只读列表中穿插编辑行；新增表单无论是否需要都常驻占屏 |
| 数据源页 | `DataSourceSummary`（状态表）+ `DataSourcePicker`（勾选）+ `ConnectionActions` | 状态展示与选择操作同屏，勾选列表本质是编辑动作却以常驻形态出现 |

## 2. 目标交互模型：页级双模式状态机

```
            ┌───────── 编辑按钮 ─────────┐
   ┌────┐   │  （locked 时禁用）          │   ┌──────┐
   │view│ ──┘                            └─▶│ edit │
   └──── ◀── 取消（还原草稿）/ 保存（提交并回 view）── └──────┘
```

**通用机制（三页一致）**：

| 机制 | 设计 | 说明 |
| --- | --- | --- |
| 模式状态 | 每页自持 `mode = ref<'view' \| 'edit'>('view')` | 归属页面层（pages/），App 与 TabBar 零感知 |
| 进入编辑 | view 顶部「编辑」按钮 | `locked`（执行锁）时禁用；A2A/数据源无草稿概念，直接切换 |
| 退出编辑 | 「保存」（有持久化语义的页面）/「取消」 | 取消 = 丢弃草稿回 view；保存 = 提交后自动回 view |
| dirty 保护 | 编辑态切走页签：**仅提示不阻断**（沿用已确认决策 ②） | 草稿保留在本页组件内，回到该页仍是编辑态与原草稿；页内展示「有未保存修改」提示 |
| 显隐 | 非激活页签仍走现有 `display:none`（不改路由机制） | 模式状态跨页签切换保留 |

## 3. 各页交互规格

### 3.1 设置页

| 形态 | 内容 | 动作 |
| --- | --- | --- |
| view | `SettingsSummary` 全量只读（已保存生效配置，apiKey 脱敏）+ 本地日志区（常驻，操作类不属表单） | 「编辑配置」按钮 |
| edit | `SettingsForm`（现有草稿 + dirty + 取消逻辑全部复用） | 「保存」「取消」；保存成功回 view（既有 `persistSettings` 的 setTab('chat') 行为保留） |

改动点：`SettingsForm` 的草稿对齐触发从 `watch(active)` 改为 `watch(mode === 'edit')`；dirty 上抛链路不变。

### 3.2 A2A 页（编辑粒度：行级，在 edit 视图内）

| 形态 | 内容 | 动作 |
| --- | --- | --- |
| view | 只读卡片列表（卡片地址 / 端点覆盖 / Token 已配置否 / 启停徽章）+ 每卡「测试连通」（只读探测，不改数据） | 「编辑绑定」按钮 |
| edit | 保留卡片列表但出现行级操作：启停 checkbox、删除、行「编辑」→ `A2aBindingEditor`（现有组件复用）；底部「新增绑定」表单（`A2aAddForm` 复用，仅编辑态渲染）；顶部「完成」按钮回 view | 行编辑确认/取消、新增提交（逻辑不变） |

改动点：编辑目标选择器移入 edit 视图头部（view 无需选目标）；编辑态入口按钮 + 完成按钮由页/编排层持有；`editingId`、testResults 等状态归属不变。

### 3.3 数据源页

| 形态 | 内容 | 动作 |
| --- | --- | --- |
| view | `DataSourceSummary`（统计 + 各页签状态徽章表） | 「调整数据源」按钮 |
| edit | `DataSourcePicker`（勾选/重置，即点即生效语义不变）+ `ConnectionActions`（连接刷新，重建类操作归编辑态） | 「完成」按钮回 view |

改动点：三组件全部复用，仅页面层加 mode 裁剪渲染。

## 4. 组件结构 old-vs-new

| 层 | 方案 A（现状） | 本设计（方案 B-lite） | 变化 |
| --- | --- | --- | --- |
| pages/SettingsPage | Summary + Form 纵排 | `mode` 状态 + 条件渲染 view/edit | 加壳，组件复用 |
| pages/A2aPage | 透传 A2aAgentsSection | 加 mode？**否** —— mode 归 A2aAgentsSection（编排层），A2aPage 仍薄壳 | 编排层内部改 |
| components/A2aAgentsSection | 卡片 + 编辑器 + 新增表单同渲 | 按 mode 分区渲染；编辑目标选择器、完成按钮进 edit 分支 | 渲染分组 |
| pages/DataSourcePage | Summary + Picker + Actions 纵排 | `mode` + 条件渲染；按钮组（编辑/完成）页面层自持 | 加壳 |
| App.ts | 不感知 | **仍不感知**（mode 不上抛；dirty 提示在页内） | 零改动 |

关键约束：所有既有编辑组件（SettingsForm/SettingsSummary/A2aBindingList/A2aBindingEditor/A2aAddForm/DataSourceSummary/DataSourcePicker/ConnectionActions）**props/emits 不变**，本设计只动三个「页面/编排」文件 + 少量样式（mode 切换按钮组）。

## 5. 实施步骤（每步独立过三闸门）

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| S1 | SettingsPage 加 mode：view=Summary+编辑按钮，edit=Form+保存/取消；Form 草稿对齐改 watch mode | tsc + vitest + eslint |
| S2 | A2aAgentsSection 加 mode：view=只读卡片+测试连通，edit=启停/删除/行编辑/新增+完成；编辑目标选择器迁入 edit | 同上 |
| S3 | DataSourcePage 加 mode：view=Summary，edit=Picker+ConnectionActions+完成 | 同上 |
| S4 | side-panel.html 补 mode 按钮组样式（.page-mode-actions 等）；手测清单 | build 后人工验证 |

## 6. 待确认决策点

1. **A2A 编辑粒度**：edit 视图内仍是「点行编辑」逐行切换（推荐，复用 editingId 单行机制）vs 整页所有行同时变编辑器（改动大、无收益）。
2. **即时操作归属**：A2A 启停/删除归 edit（推荐：view 保持纯只读）；「测试连通」是只读探测，推荐留在 view 卡片上。数据源「连接刷新」归 edit（推荐）。
3. **日志区**：设置页日志导出/清空是操作但非表单，推荐常驻两模式都显示（不随 mode 裁剪）。
4. **dirty 跨页签**：沿用已确认决策「仅提示不阻断」，编辑态切走再切回，草稿与 edit 模式保留 —— 是否需要额外在 TabBar 上加未保存标记（推荐本期不做，页内提示足够）。
