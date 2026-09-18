# 侧栏对话多会话方案设计（新建会话 + 会话历史）

> 状态：**已实施定稿**（2026-09-18 实施完成，三闸门通过；设计沿革：探索稿 v2——淘汰上限 32 可配 / 打开加载 8 可配 / 存储介质改 IndexedDB）
> 日期：2026-09-18（探索与定稿）；2026-09-18（实施落地，见 §8 实施记录）
> 范围：`packages/webmcp-chrome-extension/main-extension/side-panel` + `packages/webmcp-agent-chat-core`（最小侵入）

## 1. 需求

1. **新建会话**：对话页提供按钮，点击后主动开启新会话（当前会话保留进历史）。
2. **会话历史**：扩展侧栏打开后，展示按时间最近的 **8 个**会话记录，可点击恢复继续对话。

## 2. 现状证据分析

### 2.1 会话状态 = 单一内存 ref，无持久化

| 证据 | 位置 | 结论 |
|------|------|------|
| `const messages = ref<UiMessage[]>([])` | `side-panel/App.tsx:67` | 唯一会话状态，纯内存，侧栏关闭即失 |
| `let history: ChatMessage[] = []` | `webmcp-agent-chat-core/src/chat-controller.ts:81` | LLM 跨轮历史同为内存态 |
| `onMounted` 全流程 | `App.tsx:440-540` | 无任何会话恢复逻辑 |
| 现存「开新会话」唯一入口 | `App.tsx:394-404` `confirmSwitchAgent` | 切换智能体时 `clearHistory()` + `messages.value = []`，旧会话直接丢弃 |

### 2.2 core 库能力边界（关键缺口）

`ChatController` 接口（`chat-controller.ts:64-74`）只有：

- `getHistory()` / `clearHistory()` / `runTurn()` / `abort()` / `isBusy()`

**没有恢复历史的 API**。若要求「恢复会话后继续对话上下文连贯」，必须给 core 增补 `setHistory()`（见决策点 D2）。core 定位「零 UI、零浏览器 API」（`chat-controller.ts:8-9` 边界红线），会话持久化属宿主层职责，不应进 core。

### 2.3 可复用的既有范式

| 范式 | 位置 | 复用点 |
|------|------|--------|
| chrome.storage.local 持久化三件套 | `panel-client.ts:200-245`（loadSettings/saveSettings） | 新配置项（sessionRetentionLimit/sessionLoadLimit）持久化；会话数据本体走 IndexedDB（D6） |
| IndexedDB 三层范式（core 纯逻辑 / db IO / 门面） | `logger/logger-core.ts` + `logger-db.ts` + `logger.ts` | `sessions/` 三件套同构复用（见 §3.2.2，不复用 LoggerDb 实例） |
| 脏数据备份重建 | `a2a-config-store.ts`（`.corrupt` 备份后重建） | 会话存储容错 |
| 纯函数 ID 生成 | `logger/trace-context.ts:11-17` `generateTraceId` | 同构实现 `sess_<ts36>_<rand6>` |
| UI 注入点 | `ChatPage.tsx:55-81`（`.chat-agents` 工具条）、`MessageList.tsx:77-84`（空态） | 新会话按钮 / 会话列表位置 |

### 2.4 保存时序已验证安全

`chat-controller.ts:169-181`：`finally` 中 `onTurnSettled` 先于 `busy=false`，且成功/错误/终止路径的 `view.setText` 均先于 `onTurnSettled` —— 在 `onTurnSettled` 挂钩持久化时 `messages` 已是终态。

## 3. 方案设计

### 3.1 架构总览

```
UI 层                 App 编排层                        持久化层（IndexedDB，三层同 logger 范式）
─────────────        ──────────────────────           ─────────────────────────────────────
ChatPage             activeSessionId (ref)             session-core.ts（纯逻辑，可单测）
 ├「新会话」按钮 ──►  newSession():                     ├ upsertSessions / trimSessions
 │                   │  1. saveCurrentSession()        │ └ sliceRecent
 │                   │  2. controller.clearHistory()   
 │                   │  3. messages=[] + 新 sessionId   session-db.ts（IndexedDB IO）
 │                   │                                 ├ 库 webmcp-sidepanel-sessions v1
 │                   restoreSession(id):               │  store sessions（keyPath id）
 │                   │  1. saveCurrentSession()        │  索引 updatedAt
 │                   │  2. controller.clearHistory()   └ get/put/delete/listRecent/count
 │                   │     + controller.setHistory(...)   ← core 唯一增补（D2）
 │                   │  3. messages = 会话快照          
 │                   │  4. profileStore.setActive(agentId)
 │                   │                                 session-store.ts（门面）
SessionList          onTurnSettled ──► saveCurrentSession()（put + trim(retentionLimit)）
（空态内，≤ loadLimit）onUserMessage ──► 首条 user 消息生成标题   loadRecent(loadLimit)（打开时）
```

### 3.2 存储设计：IndexedDB（复用本地日志三层范式）

#### 3.2.1 存储介质决策（D6）：不入 storage.local，改用 IndexedDB

| 证据 | 位置 | 影响 |
|------|------|------|
| 权限表无 `unlimitedStorage` | `shell/manifest.json:12`（`["sidePanel","storage","downloads","tabs","scripting"]`） | storage.local 默认 **10MB 硬限额** |
| 淘汰上限提升至 32 条，单会话含 toolTrace 可 10–100KB+ | 本方案 | storage.local 大概率逼近/突破限额 |
| IndexedDB 配额按磁盘比例分配（GB 级），主键 put + `updatedAt` 索引游标 | — | 天然支撑「upsert 单会话 + 按时间淘汰 + 取最近 N 条」 |

#### 3.2.2 「本地日志」能力复用性分析（结论：不复用实例，复用三层范式）

`logger/` 现状：`logger-core.ts`（纯决策逻辑）+ `logger-db.ts`（IndexedDB IO）+ `logger.ts`（门面）。

**`LoggerDb` 实例不可直接复用**，原因四点：

1. **数据形态绑定**：接口 `append/rotate/readAll/readByTrace/count/clear` 全部绑定 `LogEntry` 形态与自增主键（`logger-db.ts:15-25,45`）；会话需要业务主键 `put`（upsert）/`get`/`delete` 单条，「每轮更新当前会话」与 append-only 语义不适配。
2. **清理语义不适配**：`rotate` = 7 天时间窗 + 条数上限（`logger-db.ts:82-119`），删除粒度是日志行；会话淘汰粒度是整个会话、依据 `updatedAt`、上限来自可配置 settings。
3. **生命周期与可靠性不同级**：设置页「清空日志」走 `store.clear()`（`logger-db.ts:155`）——日志可丢弃，会话是用户资产，同库共表会让清日志误删会话，必须库隔离。
4. **测试基建约束一致**：jsdom 无 IndexedDB → logger 的解法是「IO 层不单测、决策逻辑抽纯函数」，会话侧照搬即可，无需改造 logger。

**复用的范式（会话侧三层，与 logger 同构）**：

| 层 | logger 现状 | 会话侧新增 |
|----|------------|-----------|
| 纯决策逻辑（vitest 直测） | `logger-core.ts` | `sessions/session-core.ts` |
| IndexedDB IO 层（不做 jsdom 单测） | `logger-db.ts` | `sessions/session-db.ts`（独立库） |
| 门面（编排 + 失败静默） | `logger.ts` | `sessions/session-store.ts` |

#### 3.2.3 库与数据模型

- 独立库 `webmcp-sidepanel-sessions`，version 1，store `sessions`；
- keyPath `'id'`（业务主键，非自增）；索引 `updatedAt`（非 unique，淘汰/最近 N 条游标用）。

```ts
/** 单个持久化会话（session-core.ts 定义）。 */
export interface StoredChatSession {
  id: string;                // sess_<ts36>_<rand6>（主键）
  title: string;             // 首条 user 消息截断 20 字；未发消息不持久化
  agentId: string;           // 会话创建/活跃时的激活智能体
  createdAt: number;         // 毫秒时间戳
  updatedAt: number;         // 每轮 turn 结束刷新（淘汰与加载排序依据）
  messages: UiMessage[];     // UI 消息快照（含 toolTrace）
  llmHistory: ChatMessage[]; // LLM 跨轮历史快照（恢复上下文用，D2）
}
```

#### 3.2.4 配置项（D1 调整：上限 32 可配、加载 8 可配，进 PanelSettings）

| 字段 | 存储键 | 默认 | 语义 |
|------|--------|------|------|
| `sessionRetentionLimit` | `sessionRetentionLimit` | 32 | 会话保留上限；保存路径 trim 触发淘汰 |
| `sessionLoadLimit` | `sessionLoadLimit` | 8 | 侧栏打开时加载/展示的最近会话条数 |

约束 `sessionLoadLimit ≤ sessionRetentionLimit`（`loadSettings` 归一化兜底 + 表单 hint 标注）。

#### 3.2.5 读写路径与容错

- **保存（upsert）**：`put(会话)` → `trim(retentionLimit)`：`updatedAt` 降序游标保留前 N、其余 delete（淘汰发生在写入路径）。
- **加载**：`updatedAt` 降序游标取前 `loadLimit` 条 —— 32 条历史也只读 8 条，控启动开销。
- **容错**：库打开/读写失败静默降级（会话功能不可用但对话主流程不受影响，对齐 logger 门面红线 `logger.ts:23-33`）；空会话不落盘。

### 3.3 交互语义

| 动作 | 行为 | 守卫 |
|------|------|------|
| 新建会话 | 保存当前（有消息时）→ `clearHistory()` → 清空 messages → 新 sessionId | `locked` 禁用；当前会话为空时按钮禁用 |
| 恢复会话 | 保存当前 → `clearHistory()` + `setHistory(llmHistory)` → 渲染快照 → `setActive(agentId)` | `locked` 禁用点击 |
| 每轮结束 | `onTurnSettled` 自动 upsert 当前会话快照（含错误/终止文案） | 无 |
| 切换智能体 | 现有 `confirmSwitchAgent` 改造：先保存当前会话再清空（语义从「丢弃」变「归档」） | 现有 locked 守卫不变 |
| 打开侧栏 | 空新会话 + 空态展示最近 `sessionLoadLimit`（默认 8）个会话列表（D4） | 无 |

### 3.4 文件改动清单（old vs new）

| # | 文件 | 类型 | 改动要点 |
|---|------|------|----------|
| 1 | `side-panel/sessions/session-core.ts` | **新增** | `StoredChatSession` 类型；纯函数 `upsertSessions`（幂等合并）/ `trimSessions`（updatedAt 降序留 retentionLimit）/ `sliceRecent`（数组级决策，vitest 直测） |
| 2 | `side-panel/sessions/session-core.test.ts` | **新增** | upsert 幂等 / trim 淘汰序 / slice 截取单测（纯逻辑，无需 IndexedDB） |
| 3 | `side-panel/sessions/session-db.ts` | **新增** | IndexedDB IO：独立库 `webmcp-sidepanel-sessions` v1；`get/put/delete/listRecent/count`；对齐 `logger-db.ts` 范式（IO 层不做 jsdom 单测） |
| 4 | `side-panel/sessions/session-store.ts` | **新增** | 门面：open + `saveCurrent`（put + trim）/ `loadRecent(loadLimit)` / `get(id)`；失败静默降级 |
| 5 | `webmcp-agent-chat-core/src/chat-controller.ts` | 修改 | `ChatController` 增补 `setHistory(messages: readonly ChatMessage[]): void`（实现 `history = [...messages]`，零浏览器 API 合规） |
| 6 | `webmcp-agent-chat-core/src/chat-controller.test.ts` | 修改 | 补 `setHistory` 单测 |
| 7 | `side-panel/runtime/panel-client.ts` | 修改 | `PanelSettings` + `sessionRetentionLimit`(默认 32) / `sessionLoadLimit`(默认 8)；`SETTINGS_KEYS` / `DEFAULT_SETTINGS` / `loadSettings`（含 load ≤ retention 归一化）/ `saveSettings` / `toPanelSettings` 同步 |
| 8 | `side-panel/App.tsx` | 修改 | `activeSessionId` ref；`newSession/restoreSession/saveCurrentSession` 编排（配置项从 settings 传入 store）；`onTurnSettled` 自动保存；`onUserMessage` 标题生成；`confirmSwitchAgent` 改 save-then-clear |
| 9 | `side-panel/pages/ChatPage.tsx` | 修改 | `.chat-agents` 工具条新增「新会话」按钮；props 增 `hasMessages`；emits 增 `newSession` |
| 10 | `side-panel/components/SessionList.tsx` | **新增** | 最近会话列表（标题/智能体名/相对时间/消息数，点击 emit `restore`） |
| 11 | `side-panel/components/MessageList.tsx` | 修改 | 空态区块集成 `SessionList`（props 透传） |
| 12 | `side-panel/components/settings/SettingsForm.tsx` | 修改 | `numberInput` 泛化绑定 key（现硬绑 `maxHistoryTurns`）；行为组新增两个数字输入；`EDITABLE_FIELDS` + 2 字段 |
| 13 | `side-panel/components/settings/SettingsSummary.tsx` | 修改 | 行为组摘要 + 2 行 |
| 14 | `side-panel/style/chat.css` | 修改 | 新会话按钮 + 会话列表样式（复用既有 token） |
| 15 | `side-panel/i18n/zh-CN.ts` / `en-US.ts` | 修改 | 新键：`chat.newSession` / `chat.recentSessions` / `chat.sessionMeta` / `msg.sessionRestored` / `settings.form.sessionRetentionLimit` / `settings.form.sessionLoadLimit` / `settings.summary.session*` 等（zh 为基准，en 一一对应） |

- `SettingsPage.tsx` **本身零改动**：双模式编排不变，表单/摘要扩展下沉 `SettingsForm` / `SettingsSummary`（与「页面只编排」分层一致）。
- 不改：SW、桥接层、relay、A2A、调试页、`logger/`（零触碰）；`side-panel` 目录规范按现行四域目录先例新增 `sessions/`。

## 4. 关键决策点（推荐项已标注）

| # | 决策 | 推荐 | 备选 | 理由 |
|---|------|------|------|------|
| D1 | 淘汰与加载条数 | **保留 32（`sessionRetentionLimit`）、打开加载 8（`sessionLoadLimit`），两者设置页可配** | 固定常量 | 淘汰与展示解耦：历史可回溯更多，启动只读 8 条控开销 |
| D2 | 恢复 LLM 上下文 | **恢复**（core 加 `setHistory`） | 仅恢复 UI 展示，上下文清零 | 「恢复会话继续聊」的应有语义；core 改动 1 个方法，最小侵入 |
| D3 | 列表位置 | **MessageList 空态内** | 顶部下拉 / 独立抽屉 | 零新路由零新页签；侧栏窄，空态天然是列表载体 |
| D4 | 打开时默认会话 | **空新会话 + 列表可见** | 自动恢复最近会话 | 需求语义「打开后展示历史」；自动恢复会遮住空态列表，且用户可能想开新的 |
| D5 | 恢复时智能体 | **自动 `setActive(会话.agentId)`** | 仅提示不切换 | LLM 上下文属于该智能体（提示词/技能/工具），不切回会错配 |
| D6 | 存储介质 | **IndexedDB（独立库，复用 logger 三层范式，不复用 LoggerDb 实例）** | storage.local（10MB 硬限，无 unlimitedStorage） | 见 §3.2.1/§3.2.2 证据分析；会话含工具痕迹体积大、需按 updatedAt 索引淘汰 |

## 5. 验证步骤

### 5.1 只读三闸门（AI 可执行）

```bash
# 绝对路径 node，走 node_modules/.pnpm（vitest@5.0.0 / typescript@5.9.3 / eslint@9.39.5）
# typecheck → lint → test 顺序，命令以根 package.json scripts 为准
```

### 5.2 手工验证清单

1. **新建**：发 1 轮消息 → 点「新会话」→ 消息清空、列表出现旧会话；空会话时按钮禁用。
2. **自动保存**：一轮结束后关闭侧栏重开 → 空态列表含该会话（标题 = 首条消息前 20 字）。
3. **恢复**：点击列表项 → 消息与工具痕迹还原、继续追问上下文连贯、智能体自动切回。
4. **淘汰（32 可配）**：造 33 条会话 → 最旧一条消失；设置页改 `sessionRetentionLimit` → 保存后按新上限淘汰。
5. **加载（8 可配）**：历史 > 8 条时打开侧栏 → 列表仅最近 8 条；改 `sessionLoadLimit` 后重开侧栏生效。
6. **配置联动**：`sessionLoadLimit` > `sessionRetentionLimit` 时保存 → loadSettings 归一化为 retention 上限。
7. **locked**：agent 对话 / relay 调用执行中 → 新建按钮与列表项禁用。
8. **切换智能体**：确认切换后旧会话进列表（不再丢失）。
9. **IndexedDB 落位**：DevTools → Application → IndexedDB → `webmcp-sidepanel-sessions/sessions`，记录按 updatedAt 排序、主键为会话 id。
10. **容错降级**：DevTools 手动删除 IndexedDB 库或制造损坏 → 重开侧栏对话功能正常（会话列表为空/静默降级），日志不崩。
11. **i18n**：切换语言，新按钮/列表/设置项文案同步切换。

## 6. 风险与边界

| 风险 | 等级 | 缓解 |
|------|------|------|
| IndexedDB 在 jsdom 不可测（同 logger 约束） | 低 | 决策逻辑全部收敛 `session-core.ts` 纯函数（vitest 覆盖）；IO 层对齐 logger 惯例不单测，手工经 DevTools 验证 |
| 每轮结束 `put` 单会话全量快照 | 低 | 写粒度 = 单会话记录（远小于 storage.local 全量 JSON 方案）；IndexedDB 写入毫秒级；后续可节流 |
| `toolTrace.result` 含超大工具输出 | 低 | IndexedDB 容量宽裕，V1 不截断留观测；后续项：单条 result 设阈值（如 64KB）截断 |
| 库打开失败 / 数据损坏 | 低 | 静默降级：会话功能不可用但对话主流程不受影响（对齐 logger 门面红线 `logger.ts:23-33`） |
| 恢复的 `llmHistory` 与当前系统提示词/技能配置不一致 | 低 | `trimHistory` 在 `runTurn` 内逐轮裁剪自收敛；提示词每轮实时组装，无陈旧问题 |
| 多实例并发写 | 无 | MV3 side panel 单实例，不存在并发 |

## 7. 后续演进（本期不做）

- 会话删除 / 重命名 / 置顶。
- 会话内消息级搜索。
- 导出会话为 Markdown。
- 超大工具结果截断与压缩。
- 抽取通用 IndexedDB helper（`logger-db` 与 `session-db` 共用 open/transaction 模板），需触碰 logger 层，单独排期。

## 8. 实施记录（2026-09-18）

15 项改动全部落地，与 §4 清单一一对应：

| # | 改动 | 产出文件 | 状态 |
|---|------|----------|------|
| 1 | core `setHistory` 增补 | `webmcp-agent-chat-core/src/chat-controller.ts`（接口 + 浅拷贝落库实现） | ✅ |
| 2 | core `setHistory` 单测 | `chat-controller.test.ts`（浅拷贝防突变 + runTurn 续接 + 空数组等价 clearHistory，+3 例） | ✅ |
| 3 | sessions 纯逻辑层 | `side-panel/sessions/session-core.ts`（StoredChatSession / createSessionId / deriveSessionTitle / trimSessions / sliceRecent） | ✅ |
| 4 | sessions 纯逻辑单测 | `session-core.test.ts`（8 例：ID 格式 / 标题截断 / 排序截取） | ✅ |
| 5 | sessions db IO 层 | `side-panel/sessions/session-db.ts`（库 `webmcp-sidepanel-sessions` v1、store `sessions`、updatedAt 索引） | ✅ |
| 6 | sessions 门面层 | `side-panel/sessions/session-store.ts`（initSessionStore 失败静默 / saveSession put+trim / loadRecentSessions / JSON round-trip 防 DataCloneError） | ✅ |
| 7 | PanelSettings 新增 2 项 | `runtime/panel-client.ts`（默认 32/8，loadLimit > retention 归一化） | ✅ |
| 8 | 设置持久化往返测试 | `panel-client.test.ts`（补 2 字段 + 归一化测试） | ✅ |
| 9 | 设置页 UI | `components/settings/SettingsForm.tsx`（EDITABLE_FIELDS +2、numberInput 泛化）+ `SettingsSummary.tsx`（+2 行） | ✅ |
| 10 | SessionList 组件 | `components/SessionList.tsx`（relativeTime / restore emit / 空态） | ✅ |
| 11 | MessageList 空态集成 | `components/MessageList.tsx`（recentSessions 透传 + restoreSession emit） | ✅ |
| 12 | ChatPage 工具条按钮 | `pages/ChatPage.tsx`（新会话按钮，locked \|\| !hasMessages 禁用） | ✅ |
| 13 | 样式 | `style/chat.css`（`.chat-agents-new-session` + `.session-list*`，复用 token） | ✅ |
| 14 | i18n | `i18n/zh-CN.ts` + `en-US.ts`（chat.newSession/recentSessions/sessionMeta/sessionEmpty/time*/msg.*/settings.*） | ✅ |
| 15 | App.tsx 编排 | `App.tsx`（activeSessionId 游标 / archiveCurrentSession 守卫 / newSession / restoreSession / onTurnSettled 自动归档 / confirmSwitchAgent save-then-clear / onMounted 初始化） | ✅ |

**三闸门验证结果**：

| 闸门 | 范围 | 结果 |
|------|------|------|
| typecheck（tsc -p tsconfig.check.json） | core + extension 两包 | ✅ 通过（ext 首跑暴露 panel-client.test.ts:439 缺字段，已修复复跑通过） |
| test（vitest run） | core 218 passed / extension 192 passed (16 files) | ✅ 全绿（含本次新增 core 3 例 + sessions 8 例 + settings 归一化例） |
| lint（eslint .） | 仓库根 | ✅ 通过（EXIT=0） |

**遗留观察项**（非本次引入）：extension vitest stderr 存在既有噪音 `ReferenceError: chrome is not defined`（tab-source-manager selection read/persist 失败路径），对应测试全部通过，不影响闸门。

§5 手工验证清单（10 项）待加载扩展后人工执行，重点：IndexedDB 落位检查、淘汰/加载联动、恢复后上下文连贯性。

### 8.1 复检与并发预留（2026-09-18 第二轮）

用户复检两项：① 重开扩展默认行为；② 多会话并发写预留。

**复检 ①——重开扩展默认新会话：既有实现已满足，无代码缺口。** 证据链：

| 证据 | 位置 | 结论 |
|------|------|------|
| `activeSessionId = ref(createSessionId())` | `App.tsx:223` | 游标随 setup 执行生成全新 ID |
| `messages` 空 ref + `chatController` setup 内新建（history 空） | `App.tsx` / `chat-controller.ts:81` | UI 与 LLM 上下文全内存态，页面销毁即清零 |
| `onMounted` 无任何恢复逻辑（只 `initSessionStore` + `refreshRecentSessions` 只读刷列表） | `App.tsx:535-641` | 打开 = 空态 + 列表可见（D4） |
| `restoreSession` 仅由列表点击触发 | `App.tsx:276` | 恢复是显式用户动作 |

侧栏关闭 → 页面上下文销毁；重开 / 扩展 reload / 浏览器重启 = setup 重跑 = 全新会话。已在 `App.tsx` 会话编排区写入铁律注释：**onMounted 禁止默认恢复任何历史会话**。

**复检 ②——多会话并发写（预留 tab-invoked 后台 agent 任务）：存在两类真实竞态，已修复。**

修复前 `saveSession` = put（事务1）→ listAll（事务2）→ 逐条 delete（事务3..N），跨多个独立 IndexedDB 事务：

| 竞态窗口 | 场景 | 后果 |
|----------|------|------|
| A 陈旧快照过度淘汰 | 会话 X、Y 并发保存，各自 listAll 读到旧快照各自 trim | 上限可被突破至 retentionLimit + N-1 条（不丢数据，下次保存收敛；危害低） |
| B delete 迭代期间同 id 被并发更新 | 会话 R 被恢复并继续对话（同 id put，updatedAt 刷新），同时另一会话的 trim 循环正持有 R 的旧快照 | **R 被误删——正在对话的会话凭空消失（真丢数据）** |
| 结构性缺口 | `archiveCurrentSession()` 无参、闭包绑定全局单游标 | 后台任务会话（runAgentLoop）结束归档时无可用入口，调用它会错写侧栏当前会话 |

修复（三处）：

1. **IO 层原子化**：`session-db.ts` 新增 `putAndTrim(session, trimmer)`——单 readwrite 事务内 put → getAll（同事务请求按序可见，含刚写入记录）→ trimmer 同步决策 → delete 同事务发出（onsuccess 内同步发请求，事务不提前提交）。并发 readwrite 事务由 IndexedDB 串行调度，窗口 A/B 全消。
2. **决策层纯函数**：`session-core.ts` 新增 `evictionIds(all, limit)`（trimSessions 的差集表达，语义严格互补），供事务内淘汰；+4 单测（互补不变式 / 非正上限全删 / 不淘汰最新会话）。
3. **编排层会话化入口**：`App.tsx` 抽取 `archiveSnapshot(session)` 参数化归档（saveSession 本就不绑定游标），`archiveCurrentSession` 收敛为其特例（守卫 + buildCurrentSession 快照）。**tab-invoked 后台任务归档路径预留：后台任务自持 `createSessionId()` 游标与消息/历史快照，轮次结束直接调 `saveSession(snapshot, retentionLimit)`（store 层参数化入口），与侧栏当前会话并发写入互不干扰。**

三闸门复跑：typecheck ✅ / vitest 196 passed（+4 evictionIds）✅ / lint EXIT=0 ✅。

**V2 待设计（不在本期）**：后台任务归档后侧栏列表的刷新机制（跨上下文事件推送或打开时重刷，当前打开/每次保存后重刷已覆盖主场景）；后台会话在列表中的标识与展示语义（来源页签、任务标题）。

### 8.2 布局调整（2026-09-18 第三轮）

**agent 会话页重排为四区布局**（SessionList 从 MessageList 空态迁出为左侧栏常驻）：

```
┌────────────────────────────────────┐
│ 顶栏：智能体 [选择器]                │
├──────────┬─────────────────────────┤
│ 左侧栏    │  右侧区域：会话窗口       │
│ 新建会话  │  （MessageList）         │
│ 会话列表  │                         │
├──────────┴─────────────────────────┤
│ 底部栏：输入区域          [发送]     │
└────────────────────────────────────┘
```

- **移除「查看提示词」**：`inspectPrompt` 与确认条渲染、i18n 键（chat.inspectPrompt/switchConfirm/switchConfirmYes、msg.promptHeader/promptEmpty）一并删除；`composedSystemPrompt` 保留（chatController 组装用）。
- **切换智能体 = 自动创建新会话**：删除确认流（requestSwitchAgent/confirmSwitchAgent/cancelSwitchAgent），新 `switchAgent(id)` 直接执行 locked 守卫 → 归档当前 → 清空 → setActive → 新游标 → 提示。切换提示消息进新会话，受 hasUserMessage 守卫不归档（语义自洽）。
- **文件改动**：ChatPage.tsx 重写（topbar/sidebar/main/composer 四区 + SessionList 集成）；MessageList.tsx 瘦身（移除 recentSessions/agents/locked props 与 restoreSession emit，空态保留欢迎文案）；SessionList.tsx 注释更新；App.tsx 删确认流与 inspectPrompt、ChatPage 接线更新；chat.css 重写布局（.chat-topbar/.chat-body/.chat-sidebar 176px/.chat-main），清理 confirm/inspect 旧样式。

**relay 连接状态迁入【relay 调用】页签**：

- 全局 `RelayStatusBar`（App 编排区）移除，statuses 透传 RelayPage，页头下新增「连接状态」分区（relay-page-connection）常驻展示；数据源仍为 relayStore（与数据源设置页共用 store），i18n 新增 `relayPage.connection`。relay.css 补页内分区样式。

**三闸门**：typecheck ✅ / vitest 196 passed ✅ / lint EXIT=0 ✅。
