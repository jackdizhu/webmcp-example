# 智能体（Agent Profiles）功能架构探索：rules / skills 绑定（v5，核心能力整合进 chat-core）

> 状态：探索文档 v5（未进入 propose/apply）
> 日期：2026-09-12（v2：移除 mcps；v3：方案 A 定案；v4：对齐 Step1–4 迁移后架构；**v5：确认整合原则——agent 领域核心能力全量收口 `webmcp-agent-chat-core`，宿主只保留功能调用与平台适配**）
> 涉及代码：
> - `packages/webmcp-agent-chat-core/src/`（agent-loop / llm-client / chat-controller，**领域核心，全量收口地**）
> - `packages/webmcp-chrome-extension/main-extension/side-panel/App.ts`（接线层，纯委托）
> - `packages/webmcp-chrome-extension/main-extension/side-panel/pages/ChatPage.ts`（UI 层）
> - `packages/webmcp-chrome-extension/main-extension/side-panel/panel-client.ts`（平台适配：桥接/工具/设置）
> - `packages/webmcp-chrome-extension/core/builtin-tools.ts`（既有内置工具注册表，本次不动）

---

## 1. 需求描述与范围（不变）

1. 提供**可选智能体列表**（多个 Agent Profile，用户可切换）；
2. 每个智能体绑定两类核心能力配置：**rules**（分层系统提示词）与 **skills**（渐进加载能力包）；
3. mcps 本期移除，数据模型预留占位。

**v5 新增整合要求（用户确认，D5）**：agent 核心能力**整合到 `webmcp-agent-chat-core`**；其他使用方（side-panel / 未来 html-app）**只保留功能调用能力**（调库 API + 实现宿主适配器），不持有任何领域逻辑。

## 2. 现状梳理（v4 已核验，摘要）

关键事实与行号证据见 v4 §2（全部仍有效），摘要：

- 循环 / 协议适配 / 轮次编排已收口共享库：`agent-loop.ts:137,143`、`llm-client.ts:11,101,267,380`、`chat-controller.ts:78-166`（含 `clearHistory` :96-98）；
- 宿主三条缝已单点化：`App.ts` `getTools` :137-143 / `getLlmConfig` :145-152 / **`getSystemPrompt` :153**；
- 内置工具上下文 `BuiltinToolContext`（`builtin-tools.ts:374`）、`attachBuiltinTools`（`panel-client.ts:52-58`）；
- 执行锁 `App.ts:76-88`；relay 状态收口 `relay-status-store`。

## 3. 硬约束（v5 增补 C8）

| # | 约束 | 影响 |
| --- | --- | --- |
| C1 | MV3 CSP 禁 eval | 引入库零 eval；UI 走 h() |
| C2 | side panel 无 Node API | skills 以静态资产/内置数据分发 |
| C3 | IIFE 单文件，体积敏感 | 新依赖克制 |
| C4 | 优先复用上游、catalog 管版本 | 新依赖进 catalog |
| C5 | 工具命名空间机制三处消费 | 新工具不绕开现有机制 |
| C6 | 长任务用户手动执行；三闸门可自动跑 | 方案须可被三闸门验证 |
| C7 | 共享库红线：零 Vue / 零 chrome.* / 零宿主依赖 | 领域逻辑进 core，触平台 API 部分留宿主 |
| **C8（v5 新增）** | **宿主红线：只保留功能调用能力**——调库 API + 实现 core 定义的适配器接口；**禁止在宿主内实现领域逻辑**（组装/预算/解析/编排一律进 core） | core 的 `index.ts` 门面必须覆盖宿主所需的全部领域操作；宿主新增代码只剩「适配器实现 + 接线 + UI」 |

## 4. 目标数据模型（JSONC 草案，不变）

```jsonc
// chrome.storage.local 新增键：agentProfiles / activeAgentId
// 读写由宿主 ProfileStore 适配器承担；类型/校验/迁移逻辑在 core
{
  "agents": [
    {
      "id": "page-qa",
      "name": "页面问答助手",
      "description": "基于当前页面工具做问答与验证",
      "rules": {
        "inheritGlobal": true,
        "items": [ { "id": "r1", "text": "优先调用页面工具并基于真实返回回答。" } ]
      },
      "skills": [ { "id": "form-fill", "enabled": true } ],
      "mcps": [],
      "llmOverride": { "model": "deepseek-chat" }
    }
  ],
  "activeAgentId": "page-qa"
}
```

## 5. 架构调整图表（v5 核心输出）

### 5.1 整合边界：迁入 core vs 留在宿主

| 能力 | 归属 | core 交付物（index.ts 门面） | 宿主残留（仅调用/适配） |
| --- | --- | --- | --- |
| tool-use 循环 / 协议适配 / 轮次编排 | core（既有） | `createChatController` 等 | App.ts 接线（既有） |
| Profile 类型与校验 | core（新增） | `AgentProfile` 等类型 + `validateProfile` | import 使用 |
| rules 分层组装（global+agent 段 + 来源标注） | core（新增） | `composeSystemPrompt(profile, globalPrompt)` | `getSystemPrompt` 一行委托 |
| L1 技能清单生成（100k 预算 + 截断说明） | core（新增） | `buildSkillL1Section(skills, budget)` | 无 |
| 旧配置迁移（systemPrompt→默认智能体，幂等） | core（新增） | `migrateLegacySettings(legacy, existing)` 纯函数 | 宿主只在启动时调用一次并落盘 |
| Profile 存取**接口** | core（新增） | `ProfileStore` 接口（list/get/save/setActive） | `agent-profile-store.ts`：用 chrome.storage 实现接口 |
| skill 解析**编排**（覆写→assets→缺失报错顺序） | core（新增） | `createSkillResolver({loadOverride, loadAsset})` 工厂 | 宿主提供两个加载函数实现 |
| `__agent_load_skill` 工具**定义工厂** | core（新增） | `createSkillTool(resolver)`（schema + execute，返回 MCP 形状结果） | 在 `getTools` 缝按 agent 启用态注入、`callTool` 缝路由 |
| 关键词预触发（可选） | core（新增） | `matchSkillTriggers(text, skills)` 纯函数 | 无 |
| 存取**实现**（chrome.storage 读写） | 宿主 | — | `agent-profile-store.ts` |
| skill 内容**实现**（assets 打包数据 / storage 覆写读取） | 宿主 | — | `skill-assets.ts`（内置清单）+ storage 读 |
| UI（选择器 / 确认提示 / 管理视图） | 宿主 | — | ChatPage / pages |
| 切换会话语义（busy 守卫 + 确认 + 清空） | core 提供 `clearHistory`；流程编排进 core？**否——UI 确认流属宿主** | `ChatController.clearHistory()`（既有） | App.ts 切换 handler（守卫 + 确认 UI + 一行 `clearHistory()`） |

> 边界判定法（写代码时逐条对照）：**一段逻辑若不触 chrome.*/DOM/Vue 且换一个宿主依然成立 → core；否则 → 宿主适配器。**「确认弹窗」触 UI 故留宿主；「切换后必须清空历史」是领域规则，已由 core 的 `clearHistory` 承载，宿主只是调用方。

### 5.2 整合前后分层对照（ASCII）

```
【现状 v4】                                  【目标 v5：整合后】

宿主 side-panel                              宿主 side-panel（薄壳）
├─ App.ts  编排+领域知识(计划)                ├─ App.ts        三缝接线，纯委托
├─ panel-client 桥接/存储/工具                ├─ agent-profile-store  实现 ProfileStore
├─ pages/*  UI                              ├─ skill-assets  assets 清单+storage 覆写读
└─ (relay-status-store)                     ├─ pages/*       选择器/消息 UI（无领域知识）
                                            └─ (relay-status-store / logger / trace)
        │ 依赖注入接线                                │ 库 API（index.ts 门面）
        ▼                                            │ ← 注入回调（宿主实现接口）
webmcp-agent-chat-core                       webmcp-agent-chat-core（领域核心）
├─ agent-loop       循环                     ├─ agent-loop / llm-client / chat-controller（既有）
├─ llm-client       双协议                   ├─ agent-profile   类型/组装/预算/存储接口/迁移 ★新增
└─ chat-controller  轮次编排                 └─ skill-loader    解析编排/工具工厂/预触发    ★新增
                                                     ↑
                                            html-app（未来宿主，同一 API 消费）
```

### 5.3 运行时调用关系

- **实线（宿主 → core）**：`App.ts` 经 `index.ts` 门面调用 `createChatController` / `composeSystemPrompt` / `migrateLegacySettings` / `createSkillResolver` / `createSkillTool`；
- **虚线（core → 宿主注入）**：`ProfileStore`（chrome.storage 实现）、skill 双源加载（assets/storage 实现）、`onLog`（logger）、`getTools/callTool`（panel-client）；
- **core 内部调用不跨边界**：controller → loop → llm-client 全在库内，宿主无感知。

## 6. 候选方案结论（v5）

- **方案 A（定案 D1）**：按 §5 整合边界落位——core 新增 `agent-profile.ts` + `skill-loader.ts` 两个纯领域模块，宿主薄壳化。改动面：core +2 模块（+barrel 导出），宿主 +2 适配文件 + App 三缝改接 + UI，controller/loop/llm-client **零改动**。成本 **3–4 人日**。
- 方案 B（Vercel AI SDK 5）/ C（OpenAI Agents SDK）：结论不变（不推荐本期，8–12 / 7–10 人日）；
- 方案 D（重框架）：仅参考。

## 7. 分阶段落地（v5 文件级）

| 阶段 | core（webmcp-agent-chat-core） | 宿主（chrome-extension） | 依赖 |
| --- | --- | --- | --- |
| **P1** | ① `src/agent-profile.ts`：类型 + `validateProfile` + `composeSystemPrompt`（段来源标注）+ `migrateLegacySettings`（幂等）+ `ProfileStore` 接口；② `index.ts` 导出；③ 单测（组装/迁移/校验全纯函数覆盖） | ④ `agent-profile-store.ts` 实现 ProfileStore（chrome.storage）；⑤ App.ts 启动迁移调用 + 三缝改接（`getSystemPrompt` 委托 `composeSystemPrompt`、`getLlmConfig` merge `llmOverride`、切换 handler = 守卫+确认+`clearHistory()`）；⑥ ChatPage 选择器 + 确认提示 | 无新依赖 |
| **P2** | ⑦ `src/skill-loader.ts`：`createSkillResolver` + `createSkillTool`（schema + execute，MCP 形状结果）+ `buildSkillL1Section`（100k 预算，D3）+ `matchSkillTriggers`（可选）；⑧ 单测 | ⑨ `skill-assets.ts`：内置技能清单（assets 形态，D2）+ storage 覆写读取；⑩ App `getTools`/`callTool` 缝按 agent 启用态注入 `__agent_load_skill`（W2 注入点）；⑪ 调试页最终 prompt 展示（段来源标注复用） | 无新依赖 |
| P3（预留） | mcps 绑定（`mcp-sources` 领域逻辑同样进 core）+ streaming 评估 | 届时再定 | 届时再定 |

**验证口径**：三闸门全绿（core 领域逻辑全纯函数，vitest 直接覆盖）+ 用户手动 `pnpm build` + 扩展手工冒烟（选择器切换提示、新会话清空、调试页 prompt 分段、systemPrompt 幂等迁移）。

## 8. 已确认决策（v5 汇总）

| # | 决策项 | 结论 | 确认时间 |
| --- | --- | --- | --- |
| D1 | 实现方案 | 方案 A（纯自研 AgentProfile 层，零新依赖） | v3 |
| D2 | skills 内容分发 | 内置 assets + storage 覆写（同名 storage 优先） | v3 |
| D3 | L1 Token 预算 | 100,000 tokens 上限，超限截断 + 说明行 | v3 |
| D4 | 切换会话语义 | 提示确认后清空 history 开新会话（底座 `clearHistory` 已存在） | v3 |
| **D5** | **整合原则** | **agent 领域核心能力全量收口 `webmcp-agent-chat-core`；宿主只保留功能调用能力（调 API + 实现适配器接口），禁止持有领域逻辑** | **v5（本次）** |
| **D6（随 D5 落定）** | skill 工具注入点 | 工厂 `createSkillTool` 在 core；**注入点**仍在 App.ts 控制器 `getTools`/`callTool` 缝（不进 SW 侧 builtin-tools 注册表——activeAgent 属 side-panel 状态，跨上下文注入会泄漏） | v5（W2 终版） |

**遗留风险 / 实现注意**：

- D3 预算实际触顶概率低，真上限是模型上下文窗口；预算做常量 + 调试页展示实际占用；
- D4 执行锁期间禁切换（`App.ts:85-88` 同款守卫）；确认前有进行中轮次先 `abort()`；
- 旧配置迁移必须幂等（重复启动不产生重复默认智能体）；
- `__agent_load_skill` 不出现在调试页/relay 清单是有意的作用域隔离；未来如需调试页可触发，再评估 activeAgent 快照下发 SW；
- AI SDK（streaming 路线）MV3 CSP 兼容性未实测（推断项）。

## 9. 执行状态（2026-09-12 更新）

- ✅ **P1 已落地（三闸门全绿）**：
  - core：`src/agent-profile.ts`（类型 + `validateAgentProfilesState` + `composeSystemPrompt` 段来源标注 +
    `mergeLlmConfig` + `getActiveAgent` + `migrateLegacySettings` 幂等 + `ProfileStore` 接口）+ 22 例单测；`index.ts` 导出。
    实现注记：迁移默认智能体 items 为空（存量 systemPrompt 留在全局 rules 语义，组装结果与迁移前完全一致），
    故 `migrateLegacySettings` 首参仅保留调用形态（`_legacy`）。
  - 宿主：`agent-profile-store.ts`（ProfileStore 的 chrome.storage 适配 + 响应式暴露 + load 幂等迁移落盘）+ 5 例单测。
  - 接线：App.ts `getSystemPrompt`/`getLlmConfig` 委托 core、切换 handler（locked 守卫 + ChatPage 确认条 +
    `clearHistory()` + 清空 UI 消息 + `setActive` 持久化）；ChatPage 选择器与确认条；side-panel.html 样式。
  - 闸门：core tsc/eslint ✓ vitest **4 文件 63 测试** ✓；chrome-extension tsc/eslint ✓ vitest **13 文件 167 测试** ✓。
- ✅ **P1 v5.1 补充（用户反馈：单智能体无法切换）**：迁移产物改为**内置双智能体**（core `createBuiltinAgentProfiles`）——
  「单个tools调试」（`tool-debug`，不继承全局、自带单工具约束，**默认激活**）+「多轮循环智能体」（`multi-turn-loop`，
  继承全局 = 原完整多轮循环行为）；`migrateLegacySettings` 对旧版未定制默认（仅一个 `id=default` 空规则）自动升级，
  已定制数据不覆盖。旧常量 `DEFAULT_AGENT_ID/NAME` 移除，新增 `DEFAULT_ACTIVE_AGENT_ID` / `LEGACY_DEFAULT_AGENT_ID`。
  闸门：core **68 测试** ✓ / chrome-extension **167 测试** ✓ / 两包 tsc·eslint ✓。宿主零改动（D5 生效验证）。
- ✅ **P2 已落地（三闸门全绿）**：
  - core：`src/skill-loader.ts` —— `SkillSummary`/`SkillDefinition` 类型、`estimateTokens`（CJK≈1 字/token 启发式）、
    `buildSkillL1Section`（`[skills]` 段，100k 预算 D3、首条无条件收录、超限追加截断说明行）、
    `createSkillResolver`（覆写→assets→缺失报错，D2；覆写读取异常容错、id 串号防护）、
    `createSkillToolDefinition`/`parseSkillToolArgs`/`toSkillToolResult`/`toSkillToolError`（MCP 同构形状）、
    `matchSkillTriggers`（关键词预触发，**core 已实现、宿主未接线**——getSystemPrompt 缝拿不到用户消息，留待后续）；
    `composeSystemPrompt` 新增 `options.skillSection`（追加 `[skills]` 段，null agent 时忽略）+ 24 例单测。
  - 宿主：`skill-assets.ts` —— 内置技能清单 `BUILTIN_SKILLS`（首个：`page-tools-guide` 页面工具使用指南）+
    `getBuiltinSkillSummary`（L1 同步数据源）+ `createHostSkillSource`（assets + `agentSkillOverrides` storage 覆写读取，
    脏数据容错）+ 7 例单测；App.ts 三缝注入（getTools 追加 `__agent_load_skill`、callTool 本地路由、
    getSystemPrompt 拼 `[skills]` 段）。
  - 内置双智能体绑定更新：多轮循环智能体 `skills: [{ id: 'page-tools-guide', enabled: true }]`（单个tools调试不绑定）。
  - **⑪ 实现口径调整**：调试页展示改为 ChatPage 选择器旁「查看提示词」按钮（点击以消息展示最终组装 prompt，
    含段来源标注）—— DebugPage 内嵌需要跨页传递 prompt getter，收益低；如需挪回调试页再评估。
  - **已注记的简化**：L1 清单摘要固定取内置 assets（同步缝约束）；storage 覆写只影响 `__agent_load_skill`
    返回的全文内容，不影响 L1 描述（如需覆写描述，需把摘要解析异步化，后续评估）。
  - 闸门：core tsc/eslint ✓ vitest **5 文件 92 测试** ✓；chrome-extension tsc/eslint ✓ vitest **14 文件 174 测试** ✓。
- ✅ **P2 v5.2 补充（用户反馈）**：多轮循环智能体补充 rules —— `plan-first`（先列完整计划再依次执行、
  逐步汇报、调整先说明）+ `stop-on-anomaly`（数据异常必须立即停止、问题说明 + 推荐方案、澄清前不继续调用）；
  迁移新增**内置条目原位刷新**（`refreshBuiltinEntries`）：同 id 内置条目内容过时（JSON 深比较）→ 原位替换为最新定义，
  自定义条目不动、用户删除的内置条目不复活、无变化时保持引用恒等（幂等不落盘）。
  闸门：core **94 测试** ✓ / chrome-extension **174 测试** ✓ / 两包 tsc·eslint ✓。
- ⏳ **待办**：用户手动 `pnpm build`（vp pack）+ 扩展重载 + 手工冒烟（多轮循环智能体提示词含 [skills] 段、
  模型调用 __agent_load_skill 取回全文、单个tools调试无该工具、「查看提示词」展示、storage 覆写生效、
  旧存量多轮循环智能体自动补 rules）。
- ⬜ **P2 待实施**：`skill-loader.ts`（core）+ `skill-assets.ts`（宿主）+ `__agent_load_skill` 注入（App getTools/callTool 缝）。
