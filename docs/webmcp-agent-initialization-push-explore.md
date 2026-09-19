# 扩展 → 页签初始化推送：web_mcp_agent_initialization 探索稿

> 状态：✅ **已实施**（2026-09-19，与 C7 合并一次 apply 完成；实施记录见 `webmcp-agent-initialization-propose.md` 文末）
> 关联：`webmcp-chrome-extension-tab-invoked-agent-task-explore.md`（C5，已实施）、`extension-tab-communication-channels.md`（通道对比）
> 需求原话：在浏览器页签侧增加固定 tool 名称，用于扩展首次连接和 tools 变更后主动调用；并传入当前智能体信息、智能体列表、远程 A2A 智能体列表、SKILL 列表、tools 列表；tool 名称 = `web_mcp_agent_initialization`。

---

## 0. 需求理解与方向注记

「主动调用」的发起方存在两种解读，本稿默认按 **方向一（扩展 → 页签推送）** 设计，Q1 请用户确认：

- **方向一（默认）**：扩展在「首次连接」与「tools 变更」时**主动调用**页签侧的固定名工具，把五类目录**传入**页签 —— 数据流：扩展 → 页签。页面凭此感知扩展能力（当前智能体、可用 agent/A2A/skill/tool 目录），为 C5 `asyncCreateAgentTask` 提供发现机制（现在 html-app 测试按钮硬编码 agentName/toolName 的根因即缺这一环）。
- **方向二（备选解读）**：扩展暴露固定名工具，页面在扩展首次连接后、tools 变更后**主动拉取**五类目录 —— 数据流同为扩展 → 页签，但发起方是页面；页签无法感知「何时该重新拉」（变更通知仍需下行推送），闭环不完整。

> **补充需求 R4（2026-09-19，已并入）**：用户确认双通道并存 —— 推送（方向一，方案 A）之外，页签可经 C5 反调链路**主动拉取**：SDK 参考 `asyncCreateAgentTask` 新增 `asyncAgentInitialization()`，返回数据与 `web_mcp_agent_initialization` 调用时数据一致。注意这是 request/response 拉取（拉取即调用时刻最新快照），**不是**原方案 B 的下行推送（无需急建连、无需回调注册），方案 B 仍留作高频下行演进路径。设计详见 §4.3。

## 1. 需求清单

| # | 需求 | 说明 |
|---|---|---|
| R1 | 页签侧固定工具名 `web_mcp_agent_initialization` | 固定、可发现的工具契约；与 C5 的 `window.webmcpAgent` 平行 |
| R2 | 触发时机：扩展首次连接 + tools 变更后 | 主动、幂等推送；页面 reload 后应能重新收到（= 新一次首次连接） |
| R3 | 推送载荷五类目录 | 当前智能体信息 / 智能体列表 / 远程 A2A 智能体列表 / SKILL 列表 / tools 列表 |
| R4 | 页签主动拉取：SDK 新增 `asyncAgentInitialization()`（补充需求 2026-09-19） | 参考 `asyncCreateAgentTask` 形态；返回数据与 `web_mcp_agent_initialization` 推送载荷同源一致（§4.3、§5） |

## 2. 现状证据（全部已验证调用点）

| # | 机制 | 证据（文件 : 行号） | 结论 |
|---|---|---|---|
| E1 | 页面工具注册机制 | html-app `main.ts:2,12,91-93`：`@mcp-b/webmcp-polyfill` → `document.modelContext.registerTool(tool, { signal })` | 页签侧注册固定名工具与 `get_status` 同机制，零新协议 |
| E2 | 下行调用链现成 | `panel-client.ts:31` `callTool(name, args)` 按路由表投递对应页签 → `core/page-tools-bridge.ts:106-158` → MCP client → 页面 handler | 扩展 → 页签传数据**零新增传输** |
| E3 | 首次连接语义 | `panel-client.ts:316-322,601-605`：每选中页签一条 `chrome.tabs.connect`；聚合在线 = 全部目标页签收到过首条响应；`onStatusChange` 现成 | 「首次连接」= onStatusChange(true) + listTools 首次成功 |
| E4 | tools 变更钩子现成 | `panel-client.ts:607-610` `onToolsChange`；`page-tools-bridge.ts:95-104` `notifyToolsChanged`；`App.tsx:666-667` 已订阅 | tools 变更触发点零新增 |
| E5 | 页签路由与命名空间 | `panel-client.ts:4-10,556-566`：listTools 合并全部选中页签并统一加 `tab<id>__` 前缀；callTool 按暴露名路由 | 固定名在每个页签侧体现为 `tab<id>__web_mcp_agent_initialization`，可按页签分别调用 |
| E6 | 当前智能体/列表数据源 | `a2a/agent-profile-store.ts:61-75`：`agents` / `activeAgentId` / `activeAgent`（computed） | 直接可用 |
| E7 | A2A 列表数据源 + 密钥隔离 | `a2a/a2a-config-store.ts:9,23`：`a2aConfig` 键（`AgentA2aRef[]`，chat-core `a2a-config.ts:32-50`：id/cardUrl/enabled/protocol/endpointOverride/endpoint 等）；**token 在 `a2aTokens` 键分离存储，不入 a2aConfig** | A2A 条目天然无 token；但 endpoint/cardUrl 属内网地址，是否外泄见 Q3 |
| E8 | 技能清单数据源 | `runtime/skill-assets.ts:13,46`：`BUILTIN_SKILLS: SkillDefinition[]` + `getBuiltinSkillSummary`；SkillSummary = { id, name, description } | 直接可用 |
| E9 | 工具组合清单 | `App.tsx:319-327,635-658`：`attachInjectedTools(attachBuiltinTools(connectPageTools(), …), …)`；listTools = page + builtin + injected（含 `a2a__*`） | 直接可用 |
| E10 | 智能体档案敏感字段 | `AgentProfile.llmOverride`（per-agent LLM 覆盖，含 apiKey 可能）、`rules` 全文系统提示词【推断·必须白名单核实】 | 推送载荷**禁止裸传 profile 全量**，见 §5 红线 |

## 3. 关键判断

1. **下行不需要新通道**：C5 当时缺的是「页面主动发起」，而「扩展 → 页签」的 callTool 链路（E2）一直存在。初始化推送 = 扩展调用一个**页签侧注册的固定名工具**，载荷走 tool args。
2. **时序自洽无鸡生蛋**：页面在 `document_start` 后注册工具（E1），扩展连接晚于页面加载（SW 导航完成后 tabs.connect）→ 首次 listTools 清单即含该工具；若页面注册晚于首扫，`registerTool → listChanged → notifyToolsChanged → onToolsChange`（E4）会补偿触发推送。推送动作本身不改变工具清单，无死循环。
3. **信任面**：推送给页面的是能力元数据（非凭证）。红线仅两条：LLM apiKey（llmOverride）绝不外泄；A2A token 已隔离（E7）天然安全，但内网 endpoint 字段需用户定夺（Q3）。
4. **拉取与推送互补（R4）**：推送覆盖「扩展先知道」的时刻（首次连接 / 目录变更），拉取覆盖页面任意时刻的按需取用 —— 且拉取**不要求页面注册工具**（C5 通道对白名单页签天然可用，不受 Q6 过滤约束）；两者共用同一载荷构建函数，天然一致（§4.3）。

## 4. 方案对比

### 方案 A（推荐）：页签侧注册固定工具 + 扩展主动 callTool 推送

- 页面（html-app 本期实现；任意页面 = 可选的 SDK 代注册增强，Q10）经 `document.modelContext.registerTool` 注册 `web_mcp_agent_initialization`（inputSchema = 单 payload 对象；handler 存快照 + 派发 CustomEvent 供页面消费）。
- 扩展侧栏新增 `runtime/agent-init-pusher.ts`：订阅 onStatusChange / onToolsChange（E3/E4）→ 构建 payload → `callTool('tab<id>__web_mcp_agent_initialization', payload)` 逐页签推送。

| 维度 | 评价 |
|---|---|
| 传输成本 | **零新增**（复用 E2 链路） |
| 「tool 名称」语义 | 字面忠实：真实工具、在清单可见、tools 调试页可手动触发 |
| 覆盖面 | 实现了该工具的页面（按需天然过滤，Q6） |
| 缺点 | 页面须实现工具（未实现页 callTool 报错需容错）；推送借道「调用页签工具」形态略绕 |

### 方案 B（备选）：C5 下行 agent-init 消息

- agent-task 通道加下行消息：bridge Port **懒建连改急建连**（现为首个任务请求才建，`agent-task-tab-bridge.ts:40-41,81-103`），协议加 `agent-init` + 守卫扩展，SDK 增 `onAgentInitialization(cb)` + 快照缓存，html-app 镜像类型同步。

| 维度 | 评价 |
|---|---|
| 覆盖面 | 任意装有 SDK 的页面，无需注册工具 |
| 缺点 | 协议/桥接/SDK/镜像类型全链路改造；每匹配页签常开一条 Port；与 C5 任务语义混流（D2 纯净性） |
| 定位 | 若未来推送高频化（进度流）再升级，本期不建议 |

### 4.3 R4 补充设计：asyncAgentInitialization 页签主动拉取（与方案 A 并存）

**形态**：C5 四跳链路新增一类**无任务语义**的 request/response 消息 —— 拉取不创建会话、不进队列、不产生会话徽标（延续 D2 决策：任务通道纯净性）。证据落点全部来自 C5 已实施代码（行号为当前源码）。

**调用序列**：

```
页面 MAIN world (SDK)         CS 桥接                        SW 路由                       侧栏宿主
asyncAgentInitialization()
 ─ postMessage{init-request} ─▶ pending.add + 懒建 Port ─▶ 白名单闸门(L115) ─▶ 注入 sender 转发
                                                         requestPorts 登记(L123-124)       getInitSnapshot()
                                                                            ◀─ buildAgentInitPayload
 ◀─ postMessage{init-data} ─ pending.delete + 回投(L86-94) ◀─ requestId 路由回页签(L164-170) ◀─ {init-data, payload}
 resolve(payload)

失联补偿：任一跳 Port 断开 → task-error(EXTENSION_HOST_UNAVAILABLE) → SDK reject，不悬挂
（桥接 L95-100 failPending 既有语义，init-request 在途时自动被覆盖）
```

**四跳改动点（最小侵入，每跳 ≤ 1 分支）**：

| 跳 | 文件 | 改动 |
|---|---|---|
| 协议 | `core/agent-task-protocol.ts` | 新增线消息 `AgentTaskInitRequestMessage{type:'init-request',requestId}` 与 `AgentTaskInitDataMessage{type:'init-data',requestId,payload:AgentInitPayload}`；`AgentTaskTabMessage`/`isAgentTaskTabMessage`（L268-277）与 `AgentTaskHostReplyMessage`/`isAgentTaskHostReplyMessage`（L280-289）各扩一分支。错误码复用既有全集（ORIGIN_NOT_ALLOWED / EXTENSION_HOST_UNAVAILABLE / PROTOCOL_MISMATCH / EXECUTION_FAILED / TASK_TIMED_OUT），**无新增**（Q13 已确认：拉取无开关约束，`INIT_DISABLED` 不再需要） |
| SDK | `shell/agent-task-sdk.ts` | `WebMcpAgentSdk`（L41-51）新增 `asyncAgentInitialization(): Promise<AgentInitPayload>`；复用 pending Map（L67-70）与应答监听（L72-94），加 `init-data → resolve(payload)` 分支；无入参（无需 structuredClone 预检）；SDK 侧 10s 兜底超时 → reject TASK_TIMED_OUT（Q12） |
| 桥接 | `core/agent-task-tab-bridge.ts` | onWindowMessage（L105-145）：`init-request` 与 `create-task` 同路（pending.add + ensureHeartbeat + 转发）；Port onMessage（L86-94）「非 ack 即 pending.delete」对 init-data 天然生效，**零改动** |
| 路由 | `core/agent-task-router.ts` | onTabMessage（L93-137）：新增 init-request 分支，**复用同一白名单闸门（L115-118）与宿主可用性检查（L119-122）** → 注入 sender（`AgentTaskRoutedInitRequestMessage`）→ requestPorts 登记 → 转发；宿主应答路由（L164-170）「非 ack 即释放」对 init-data **零改动** |
| 宿主 | `side-panel/runtime/agent-task-host.ts` | connect 监听（L515-518）新增 init-request 守卫分支：新依赖 `getInitSnapshot()`（App 组装、与 pusher 共享同一实例）→ `buildAgentInitPayload(snapshot)`（chat-core 纯函数，try/catch）→ reply `{type:'init-data',payload}`；构建异常 → task-error EXECUTION_FAILED；**不触碰 acceptTask / 队列 / 会话建档** |
| html-app | 镜像类型 + 联调 | `WebMcpAgentSdk` 镜像最小声明加方法（AgentInitPayload 类型自 chat-core type-only 引入）；测试面板加「拉取初始化数据」按钮（展示 payload，可与推送工具返回值对照验证一致性） |

**一致性口径（R4 核心承诺：返回数据与 `web_mcp_agent_initialization` 调用时数据一致）**：

- **同源**：推送（agent-init-pusher）与拉取（宿主 init-request 分支）共用同一 `buildAgentInitPayload`（chat-core 纯函数，§5 白名单制）+ 同一快照提供者（App.tsx 组装一次：agents / activeAgentId / a2aConfig / skills / tools，其中 listTools / listAgentProfiles / listSkillSummaries 均为宿主既有依赖 L59-80）—— 结构上不可能分叉。
- **同构**：「一致」= 同 schema 同白名单（同一函数产物）；不承诺同一时刻快照 —— 拉取返回调用时刻最新值（推送是触发时刻值），两者语义均正确。
- **单测锁死**：chat-core 脱敏矩阵单测 + 「双路同函数」断言（同一快照输入 → 推送构建结果 deep-equal 拉取构建结果）。

**安全面**：拉取请求与 create-task 同受 `tabInvokeAllowlist` 默认拒绝闸门（无新增信任面）；应答载荷走 §5 红线（llmOverride / A2A token 永不出现）；页签伪造 init-data 自答仅能欺骗本页自身请求（SDK 只认 BRIDGE_SOURCE + 本窗口 source，SDK L72-79 既有边界，自伤不越权）。

**推荐方案 A**；B 留作演进路径；**R4 拉取与 A 并存采纳（用户已点名补充）**。

## 5. 推送载荷草案（白名单制）

```jsonc
{
  "version": 1,
  "pushedAt": 1729300000000,
  "currentAgent": { "id": "a2a-analyst", "name": "通用智能体" },   // 由 activeAgentId 解析；无则 null
  "agents": [
    // ✅Q2 定案：仅 id/name/description（rules 全文、llmOverride 永不入载荷）
    { "id": "tool-debug", "name": "工具调试", "description": "…" }
  ],
  "a2aAgents": [
    // ✅Q3 定案：仅 id/name/protocol/enabled（cardUrl/endpoint 内网地址不入载荷；token 已隔离于 a2aTokens 键）
    { "id": "…", "name": "…", "protocol": "jsonrpc", "enabled": true }
  ],
  "skills": [ { "id": "page-tools-guide", "name": "页面工具使用指南", "description": "…" } ],
  "tools": [
    // ✅Q4 定案：含 inputSchema 全量；每页签裁剪 = 该页签自身工具（裸名）+ 扩展侧工具（原样）
    // 不含 tab<id>__ 前缀（其他页签工具名不外泄，页面经 asyncCreateAgentTask 调用时由宿主 4 步解析兜底）
    // 通道工具 web_mcp_agent_initialization 本身不进载荷（Q7 不可见口径）
    { "name": "get_status", "description": "…", "inputSchema": { } }
  ]
}
```

**脱敏红线**（buildAgentInitPayload 纯函数强制，配单测矩阵）：`llmOverride`（apiKey）与 A2A token 永不出现在载荷；A2A 列表来自 `a2aConfig` 快照 + 显式字段映射（同 `toA2aConfigSnapshot` 白名单范式）。

**一致性口径（R4）**：推送与拉取共用同一 `buildAgentInitPayload` + 同一快照提供者（App 组装一次、两路共享注入），「一致」= 同 schema 同白名单；拉取返回调用时刻最新快照（详见 §4.3）。

## 6. 触发时序（方案 A）

1. **首次连接**：`onStatusChange(connected=true)` 后首次 `listTools` 成功 → 对「**已连接** 且工具清单含 `web_mcp_agent_initialization`」的页签（Q6 已确认 2026-09-19），按其暴露名 `tab<id>__…` 分别 callTool 推送（四类目录相同；**tools 维度按页签裁剪**——自身裸名工具 + 扩展侧工具，见 §5 定稿；逐页签一次）。
2. **tools 变更**：`onToolsChange` → 去抖（Q8，建议 500ms）→ 重扫清单 → 对「已连接且含该工具」的页签重推（同 Q6 口径）。
3. **容错**：callTool 失败（页面 handler 未就绪等）→ 记 `logEvent('tasks'|'app')` 日志，不重试风暴；待下次 toolsChanged 自然重试。
4. **幂等**：页面 handler 以最新快照覆盖 + 派发事件，重复推送无害。

## 7. 改动面预估（方案 A）

| 模块 | 改动 | 量级 |
|---|---|---|
| chat-core | `AgentInitPayload` 类型 + `buildAgentInitPayload` 白名单纯函数 + 单测（脱敏矩阵） | 小-中 |
| 扩展侧栏 | `runtime/agent-init-pusher.ts`（订阅/构建/逐页签推送/去抖/日志）+ App 接线（E6-E9 数据源注入） | 中 |
| html-app | 注册 `web_mcp_agent_initialization` 工具（handler 存快照 + CustomEvent）+ 测试面板「初始化数据」展示区 | 小-中 |
| i18n/设置 | 无改动（Q9 已确认：不设隐私开关，隐私边界收敛到载荷白名单 Q2/Q3） | 零 |
| 协议（R4） | init-request / init-data 线消息 + 双守卫扩分支 | 小 |
| SDK（R4） | asyncAgentInitialization 方法（复用 pending；10s 兜底超时，Q12） | 小 |
| 桥接/路由（R4） | init-request 转发分支（白名单闸门复用；失联补偿既有零改动） | 小 |
| 宿主（R4） | init-request 处理分支 + getInitSnapshot 依赖注入 | 小 |
| 文档 | 本稿 → propose → 实施记录 | 小 |

## 8. 开放问题（已全部确认，2026-09-19）

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | 方向确认：扩展主动推送（方向一/方案 A）？ | ✅ 视为已确认（2026-09-19，用户对 Q6/Q10 的应答均以推送与拉取并存为前提；如有异议请指出） |
| Q2 | agents 白名单是否含 rules 全文？（含 = 页面可读系统提示词；不含 = 仅 id/name/description） | ✅ 已确认：**不含**，仅 id/name/description（llmOverride 永不入载荷） |
| Q3 | a2aAgents 是否含 cardUrl/endpoint（内网地址）？ | ✅ 已确认：**不含**，仅 id/name/protocol/enabled |
| Q4 | tools 列表是否含 inputSchema 全量？ | ✅ 已确认：**含**；工具名 = 该页签自身工具（裸名）+ 扩展侧原样，不含 `tab<id>__` 前缀（§5 定稿） |
| Q5 | 除 tools 变更外，智能体/A2A/技能/当前智能体切换是否也触发重推？ | ✅ 已确认：**是**（App 侧 watch → 同一去抖，防目录漂移） |
| Q6 | 推送目标：全部选定页签 vs 仅白名单页签 vs 仅实现了该工具的页签？ | ✅ 已确认（2026-09-19）：**已连接且工具清单含该工具的页签**（口径已并入 §6） |
| Q7 | 该工具是否对 agent 循环可见可调用（出现在 tools 清单中）？ | ✅ 已确认：**不可见**（用户裁定：避免过度调用）——agent 循环与工具任务清单均过滤该工具；tools 调试页保留可见供人工触发；实现见 propose §2 |
| Q8 | onToolsChange 去抖窗口？ | ✅ 已确认：500ms |
| Q9 | 是否需要设置开关（隐私：页面可感知扩展全部能力清单）？ | ✅ 已确认（2026-09-19）：**不设置隐私开关功能** —— 连接后即可推送/拉取，设置页零新增；隐私边界完全由载荷白名单承担（Q2/Q3 字段取舍 + 脱敏红线） |
| Q10 | SDK 代注册增强（任意页面自动注册该工具，覆盖「未实现页面」）是否纳入本期？ | ✅ 已决策（2026-09-19）：**不纳入**，且上升为设计红线 —— **扩展不在浏览器页签注册任何 tool 工具**（甲/丙一并否决，详见 §9 结论） |
| Q11 | `asyncAgentInitialization` 命名语义 | ✅ 已确认（2026-09-19）：「sync」改「async」→ 定名 `asyncAgentInitialization`（与 `asyncCreateAgentTask` 同范式，返回 Promise；协议线消息相应定名 `init-request`/`init-data`） |
| Q12 | 拉取 SDK 侧 10s 兜底超时（超时 reject TASK_TIMED_OUT）？ | ✅ 已确认：是（正常毫秒级返回，仅防宿主异常悬挂） |
| Q13 | 拉取是否同受 Q9 隐私开关约束？关闭时行为 = 拒绝并回错误？ | ✅ 已确认（2026-09-19）：**无开关约束，连接后即可获取**（可用性 = tabInvokeAllowlist 白名单 + 侧栏宿主就绪，既有闸门）；`INIT_DISABLED` 错误码不再需要 |

## 9. Q10 详述：SDK 代注册增强（已决策：不纳入）

**定位**：方案 A 的覆盖面增强。方案 A 要求页面显式注册 `web_mcp_agent_initialization` 工具（本期 html-app 实现）；未实现页面被 Q6 过滤，收不到推送。代注册 = 扩展注入的 MAIN world SDK **代替页面**完成注册，让接入 SDK 的页面零代码收到推送。

**两个前置事实（设计约束）**：

1. `document.modelContext` 由页面自带 `@mcp-b/webmcp-polyfill` 提供（html-app main.ts:2），扩展**不注入 polyfill** —— 无 polyfill 页面既无 modelContext 也无页侧 MCP server，扩展发现链（panel → page-tools-bridge → 页面 MCP client）无物可发现。**代注册不解决无 polyfill 页面**（那需要扩展注入完整 modelContext + 页侧 MCP server 兼容层，属另一个量级的特性，本期不考虑）。
2. polyfill 同名重复注册抛 `InvalidStateError`（先 abort 再注册）；是否存在「枚举已注册工具」的 API **待核验**（影响冲突探测手段）。

**功能点拆解（7 项）**：

| # | 功能点 | 说明 |
|---|---|---|
| 1 | 触发时机 | SDK 安装时执行一次：`document.modelContext` 存在且同名工具未注册 → 代注册；polyfill 晚于 SDK 就绪（罕见，SDK 于 document_idle 注入通常晚于页面脚本）→ 一次性就绪探测后补注册，不做常驻轮询 |
| 2 | 注册内容 | 固定名工具，inputSchema 与方案 A 相同（单 payload 对象）；默认 handler = 快照缓存 `window.webmcpAgent.lastAgentInitialization`（只读）+ 派发 `CustomEvent('webmcp-agent-initialization', { detail })` —— 与 html-app 自注册实现同构，保证两路行为一致 |
| 3 | 冲突语义（页面优先） | 页面自行注册同名工具 → 代注册让位。探测手段两案：a. polyfill 枚举 API（待核验）；b. 显式声明约定：SDK 注入前页面声明 `window.webmcpAgentInit: 'auto'（默认）/ 'self'（自管）/ 'off'（不要）` —— 推荐 b（可 a+b 并用，声明优先） |
| 4 | 生命周期 | 代注册工具挂 SDK 持有的 AbortSignal；页面导航销毁 MAIN world 自然回收，无需额外清理 |
| 5 | 可见性影响 | 代注册后工具进入该页签 listTools 清单（`tab<id>__web_mcp_agent_initialization`）→ tools 调试页可见、agent loop 可调用（Q7 已裁定可见无妨：调用 = 读快照无副作用） |
| 6 | 覆盖面（Q6 联动） | 推送范围从「显式实现页面」扩大到「manifest matches 命中 + 有 polyfill」的全部页面；仍受 Q6「已连接」过滤与 Q9 隐私开关约束（联动决策：开关关闭时，代注册保留 or 一并停用） |
| 7 | 脱敏一致性 | 代注册不改变载荷来源 —— 仍由扩展侧 `buildAgentInitPayload` 产出，红线（llmOverride / A2A token）不变 |

**风险/代价**：

- **惊讶面**：页面未表达意愿即被注入工具（modelContext 出现页面没写的工具）；「默认 auto」自带惊喜 —— 声明约定的 `'off'`/`'self'` 可消除，但**默认值取 auto 还是 off 本身就是决策点**。
- **待核验依赖**：polyfill 是否提供工具枚举 API；`registerTool` 对 AbortSignal 的具体行为。
- **维护面**：SDK 三态行为（self/auto/off）+ 测试矩阵约 ×2；SDK 注入脚本体积增加。
- **协议面**：无 —— 代注册只发生在页侧 modelContext，不动 C5 协议与推送链路。

**决策选项**：

| 选项 | 内容 | 代价 | 覆盖面 |
|---|---|---|---|
| 甲 | 本期纳入：默认 `auto` + `webmcpAgentInit` 声明约定（可 off/self） | 中（三态逻辑 + 测试矩阵 ×2） | manifest matches + polyfill 页面全覆盖 |
| 乙 | 本期不纳入（探索稿原倾向），仅 html-app 等显式实现页面注册 | 零 | 显式实现页面 |
| 丙 | 折中：SDK 提供显式 opt-in API `registerAgentInitializationHandler(handler)`，页面一行调用、SDK 代为注册 modelContext 工具 | 小；无惊讶面（显式调用才注册） | 主动接入的页面 |

**决策结果（2026-09-19 用户裁定）**：

- **不纳入代注册**（乙），且**甲/丙一并否决** —— 上升为设计红线：**扩展不在浏览器页签注册任何 tool 工具**。扩展永不向页面 modelContext 注入工具；`window.webmcpAgent` 命名空间继续只含任务/拉取方法（`asyncCreateAgentTask` / `asyncAgentInitialization`），不含任何注册能力。
- 该红线与现状一致（当前架构中扩展从未向页面注册过工具 —— 页面工具一律由页面自身经 polyfill 注册），本次将其明文化为长期约束。
- 页面侧自注册保留（html-app 等页面自己注册 `web_mcp_agent_initialization`），属页面自身行为，不违反红线。
- 本节功能点/选项表保留作为决策依据存档，不再推进。
