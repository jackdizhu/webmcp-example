# webmcp-agent-chat-core 的 A2A 协议接入设计（agent ↔ agent 连接调用）

> 状态：设计定稿（开放问题已于 2026-09-12 全部确认，见 §7 决策记录；可进入 openspec-propose）
> 日期：2026-09-12
> 关联模块：`packages/webmcp-agent-chat-core`（协议纯逻辑）、`packages/webmcp-chrome-extension`（宿主接线）、`packages/webmcp-extension-relay`（P2 反向暴露）
> 协议基线：A2A v1.0（Linux Foundation Agentic AI Foundation，2026-03 稳定；JSON-RPC 2.0 over HTTPS 为主绑定）

---

## 0. 标注约定

- **[已验证]**：基于本仓库当前源码逐行核实（含文件与行号）。
- **[协议]**：基于 A2A v1.0 公开规范（Agent Card / Task / message/send 等）。
- **[推断]**：设计推演，需实现前进一步确认。

---

## 1. 背景与目标

`webmcp-agent-chat-core` 是纯逻辑 agent 对话领域库（tool-use 循环、LLM 协议适配、轮次编排、Profile/rules/skills）。当前 agent 的能力边界止于「页面工具 + 扩展内置工具」。目标：

1. 让本地侧栏 agent 能够**发现远程 agent**（Agent Card）、**委派任务**（message/send）、**跟踪任务状态**（Task 生命周期）、**取回结果**（message + artifacts）——即 A2A 客户端角色。
2. 以最小侵入接入现有 agent 循环：不引入第二套对话编排，复用 `executeTool` 缝。
3. 保持 core 库红线：纯逻辑、零 Vue、零 chrome.*、全部依赖注入（C7/C8，见 `agent-profile.ts:7-8` 注释）。

**范围澄清**：A2A 管 agent↔agent 的任务委派；MCP/WebMCP 管 agent↔tool 的能力调用。本项目已覆盖后者（页面 WebMCP 工具 + relay），本设计只补前者，二者互补不重叠 [协议]。

---

## 2. 现状分析：可复用的缝 [已验证]

| 缝 | 位置 | 对 A2A 的意义 |
|---|---|---|
| 工具执行缝 `AgentLoopDeps.executeTool` | `agent-loop.ts:57` | 远程 agent 调用可整体包装为一个「工具」执行，循环零改动 |
| 工具清单缝 `ChatControllerDeps.getTools/callTool` | `chat-controller.ts:34-36` | 宿主在 App 层把 A2A 工具合入清单即可被模型感知 |
| 工具源合成模式 `attachBuiltinTools` | `panel-client.ts:52-78` | listTools 合并 + callTool 优先级路由的标准范式，A2A 工具源照此编写 |
| 统一结果契约 MCP `CallToolResult {content,isError}` | `builtin-tools.ts:1-22` 头注释 | 内置/页面/技能三处已统一；A2A 工具结果必须走同一形态，否则 relay 端 `normalizeCallToolResult` 会降级 isError |
| Profile 引用模式 `AgentSkillRef {id,enabled}` | `agent-profile.ts:24-28` | 远程 agent 引用照此扩展（`a2aAgents`），含校验与迁移先例（`migrateLegacySettings`） |
| 技能 L1 清单模式 `buildSkillL1Section` | `skill-loader.ts:60-89` | 远程 agent 数量多时，卡片 skills 摘要清单可复用同一「预算 + 截断」思路注入工具描述 |
| mcps 预留占位 | `agent-profile.ts:46-48` | 语义是 MCP servers，不复用；新增独立字段 `a2aAgents`（见 D5） |

---

## 3. A2A 协议要点速览 [协议]

- **发现**：服务端在 `/.well-known/agent-card.json`（RFC 8615）发布 Agent Card：`name / description / version / supportedInterfaces[]（url + protocolBinding + protocolVersion）/ capabilities{streaming,pushNotifications,...} / defaultInputModes / defaultOutputModes / skills[]（id,name,description,tags）`，v1.0 起支持 JWS 签名。
- **操作**：JSON-RPC 2.0 —— `message/send`（同步阻塞）、`message/stream`（SSE 流式）、`tasks/get`、`tasks/cancel`、push notification 配置族。
- **Task 生命周期**：`submitted → working →（input-required）→ completed | failed | canceled`；task 上累积 messages 与 artifacts。
- **消息模型**：`Message{role, parts[]}`，Part 分 `TextPart / FilePart / DataPart`。
- **P0 取舍**：浏览器扩展无公网 webhook，**不做 push notifications**；gRPC / HTTP+JSON 绑定不做，仅 JSON-RPC。

---

## 4. 总体架构

```
┌─ 本地扩展上下文 ────────────────────────────────┐
│  agent-loop ──executeTool──▶ 工具源合成层        │
│  (chat-controller 编排)      页面 + 内置 + A2A   │
│                                   │             │
│              a2a-client（chat-core 纯逻辑）       │
└───────────────────────────────────┬─────────────┘
                       JSON-RPC 2.0 │ HTTPS（fetch 注入）
                          message/send · message/stream
                          tasks/get · tasks/cancel
                                    ▼
                        远程 A2A Agent（agent-card.json）
```

核心思想：**A2A-as-Tools** —— 每个已配置的远程 agent 暴露为一个（或一组）工具给本地 agent 循环；模型用既有 tool-use 能力完成「选择远程 agent → 发消息 → 处理任务结果」，无需修改 agent-loop / chat-controller 任何一行。

---

## 5. 设计决策（D1–D9）

### D1 远程 Agent 以工具形态接入（方案对比）

| 方案 | 描述 | 结论 |
|---|---|---|
| A. A2A-as-Tools | 每个 remote agent = 1 个工具，走 `executeTool` 缝 | **采纳**。循环零改动、调试页可直接手动调试、relay 端天然可透出 |
| B. 独立子循环编排 | 新写 orchestrator 在 chat-controller 内嵌套 runAgentLoop | 否决。重复编排、busy/abort/trace 语义全要重造 |
| C. 事件总线直连 | agent-loop 增加对 A2A 的原生认知 | 否决。污染纯循环，违反 core 单一职责 |

### D2 协议纯逻辑落位 core，transport 注入

新增三文件（`packages/webmcp-agent-chat-core/src/`）：

- **`a2a-types.ts`**：`AgentCard / AgentSkill / A2aTask / A2aTaskState / A2aMessage / A2aPart` 纯类型 + `validateAgentCard(value): AgentCard` 运行时校验（存储与网络数据不可信，先例：`validateAgentProfilesState`，`agent-profile.ts:169`）。
- **`a2a-client.ts`**：`createA2aClient(deps: { fetch: typeof fetch; onLog?: LlmLogFn })` → `fetchAgentCard(cardUrl) / sendMessage(endpoint, message, opts) / getTask / cancelTask`。JSON-RPC 2.0 组包与错误分型纯逻辑；**fetch 由宿主注入**（与 `createLlmClient(config, fetch, onLog)` 同款注入式，`chat-controller.ts:128` 先例）。
- **`a2a-tool-source.ts`**：卡片 → `AgentTool` 描述生成、`callTool` 编排（send → 轮询/收流 → 结果文本化）、`CallToolResult` 包装。

### D3 工具暴露形态

每个远程 agent 一个工具（默认），命名进入独立命名空间（先例：内置 `chrome_extension_*`，`builtin-tools.ts:28`）：

```
工具名：a2a__<agentKey>__send_task
inputSchema：{ message: string; taskId?: string }
```

- `agentKey` 由 profile 配置生成（稳定、可读），工具 `description` 拼入卡片 `name/description/skills[]` 摘要 —— 模型据此选择调用哪个远程 agent（与 skill L1 清单同一动机）。
- `taskId` 可选：`input-required` 场景下携答复续传同一任务（见 D6）。
- **降级形态 [推断]**：远程 agent 超过 ~10 个时，改为统一工具 `a2a__send_task{agentId, message, taskId?}` + 系统提示注入 L1 清单，控制 tools 段 token。P0 不做。

### D4 工具结果统一 MCP CallToolResult（硬契约）

`a2a-tool-source.ts` 的所有出口（成功/失败/超时/input-required）一律 `{ content: [{type:'text',text}], isError }` [已验证：relay 端 CallToolResultSchema 校验会降级非标形态，`builtin-tools.ts:8-12` 头注释]。文本化规则：

- `completed`：最终 assistant 消息文本 + artifacts（TextPart 原文；FilePart/DataPart 序列化为带标注的文本块）。
- `failed/canceled`：`isError: true`，文本携带状态与远端错误。
- `input-required`：`isError: false`，结构化文本（`state/input-required` + `taskId` + 远端问题），见 D6。

### D5 Profile 扩展：`AgentProfile.a2aAgents`

```ts
export interface AgentA2aRef {
  id: string;          // 稳定 agentKey（工具名用）
  cardUrl: string;     // Agent Card URL（含 /.well-known/agent-card.json 或其 origin）
  enabled: boolean;
}
// AgentProfile 增加字段：a2aAgents: AgentA2aRef[]（默认 []，旧数据迁移时补空数组）
```

- `mcps` 占位保持不动（语义不同）[已验证：`agent-profile.ts:46-48`]。
- **id 稳定性（2026-09-12 已确认）**：`AgentA2aRef.id`（agentKey）一经创建不可变、仅 `cardUrl` 可改 —— 工具名 `a2a__<id>__send_task` 随 id 稳定，不随 URL 漂移。
- 校验器 `validateAgentProfilesState` 补 `a2aAgents` 分支（照 `skills` 分支写法，`agent-profile.ts:201-207`）。
- `refreshBuiltinEntries` 深比较基于 JSON 序列化，新增字段后内置条目需同步工厂默认值，否则会触发一次幂等刷新 [已验证机制：`agent-profile.ts:150-163`]。
- 凭据（每远程 agent 的 bearer token）**不进 profile**：放 settings（宿主 chrome.storage），core 经 deps `getToken(agentId)` 读取 —— 对齐「apiKey 不允许覆写进 profile」的既有安全立场 [已验证：`agent-profile.ts:30-31`]。

### D6 任务生命周期映射（关键编排）

`a2a-tool-source.ts` 的 callTool 编排（P0 阻塞式）：

1. `message/send`（阻塞，超时 120s，可配）。
2. 响应为终态（completed/failed/canceled）→ D4 出口。
3. 响应为 `input-required` → 直接返回结构化 tool result（taskId + 远端问题）。**模型向用户转述追问，用户答复后模型携 `taskId` 再次调用同一工具**——复用 agent-loop 既有多轮机制，`agent-loop.ts` 零改动。这是本设计的最小侵入点。（UX 方案已确认：P0 不做专用输入框 UI，见 §7-2）
4. 响应为 `working` 且连接保持（SSE 场景，P1）→ 继续收流直至终态；P0 阻塞式下服务端会在同一响应内给终态（A2A `message/send` 语义保证返回最终状态 [协议][推断：部分实现可能返回 working，需 P0 兼容一次 `tasks/get` 轮询，间隔 2s、上限 60 次]）。

**事件映射（P1）**：`AgentLoopEvent` 增加向后兼容的 `{type:'tool_progress', name, text}`（UI 对未知事件类型忽略即可，现有 `ChatTurnView.onEvent` 宿主按需消费），SSE 状态更新映射为 progress 事件。

### D7 工具源合成与命名冲突（已确认）

- 新建 `A2aToolsClient`（实现与 `PageToolsClient` 同形的 `listTools/callTool` 子集），App 层按「页面工具 → 内置 → A2A」顺序合成（与 `attachBuiltinTools` 同款包装，`panel-client.ts:52-78` 范式）。
- 命名空间隔离（`a2a__` 前缀）使冲突不可能发生（2026-09-12 确认维持）；若页面工具/内置工具被恶意占用 `a2a__` 前缀，A2A 层最高优先级剔除（对齐「内置优先」策略 [已验证：`builtin-tools.ts:116-119`]）。

### D8 安全与边界

| 风险 | 对策 |
|---|---|
| 任意 URL 调用（SSRF / prompt injection 诱导外呼） | 只允许 profile `a2aAgents` 白名单内的 `cardUrl`；工具清单只暴露 enabled 条目；callTool 收到未知 agentKey 一律 isError |
| 凭据泄露 | token 存 settings 不入 profile / 不入日志（对齐 `onLog` payload 不含鉴权数据的既有约定，`chat-controller.ts:9`） |
| 远端输出注入 | 远端文本以 tool result 身份进上下文，与页面工具同级风险；`failed` 保持 isError 语义；artifacts 文本块加来源前缀 |
| 卡片伪造 | P0 校验 cardUrl 与 endpoint 同源（HTTPS）；P1 评估 JWS 签名校验（v1.0 signatures）[协议] |
| 无限循环 / 成本失控 | 远程调用计入 agent-loop `maxIterations`（天然限流 [已验证：`agent-loop.ts:144,158`]）；单次任务超时 120s；A2A 循环引用（远端回调本地）在 P2 server 方向另行加 depth 限制 |
| 长任务与侧栏生命周期 | P0 阻塞式依赖侧栏存活（MV3 侧栏关闭即中断，AbortSignal 已有缝 [已验证：`chat-controller.ts:120-121`]）；P1 考虑 tasks/get 恢复未竟任务 |

### D9 反向角色：本地 agent 作为 A2A 服务端（P2，单列不阻塞 P0）

relay 已是 Node HTTP/WS 服务 [已验证：`webmcp-extension-relay/src/mcpRelayServer.ts` 存在]，可增量挂载：

- `GET /.well-known/agent-card.json` → 静态卡片（描述本地侧栏 agent 的 skills）。
- `POST /`（JSON-RPC `message/send`）→ 经既有 WS 桥接（bridgeServer）把消息转给侧栏 `createChatController` 跑一轮，最终文本作为 Task completed 返回。

风险 [推断]：侧栏未打开时会话不存在 → 卡片 `capabilities` 如实声明、离线时返回 task failed；MV3 SW 休眠依赖侧栏保活，与现状一致。

---

## 6. 分期实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0（MVP）** | a2a-types（含卡片校验）+ a2a-client（JSON-RPC blocking send / getTask / cancelTask，fetch 注入）+ a2a-tool-source（单工具暴露、input-required 结构化返回、CallToolResult 包装）+ Profile.a2aAgents（校验/迁移）+ 设置页「远程 Agent」管理（URL + token + 连通测试） | core 三模块 + 宿主接线 + vitest 单测（transport 桩覆盖卡片校验/状态机/超时/错误分型/input-required 续传） |
| **P1** | message/stream（SSE）+ `tool_progress` 事件扩展 + 卡片 JWS 校验评估 + 统一工具降级形态（agent 数多时） | 流式进度上屏（MessageList 工具痕迹区） |
| **P2** | relay 反向 A2A server（D9）+ 本地 sub-agent 编排（profile 内 agent 互调，复用同一工具缝但独立 `sub_agent__` 命名空间（2026-09-12 已确认），无网络） | 本地/远程统一的 agent 组合能力 |

验证闸门沿用项目三闸门（typecheck / lint / test，绝对路径 node 直跑 [已验证：见项目 MEMORY 环境要点]）。

---

## 7. 决策记录（2026-09-12 已确认，原开放问题全部关闭）

| # | 决策项 | 结论 |
|---|---|---|
| 1 | **D7 命名空间隔离** | `a2a__` 前缀使工具名冲突不可能发生，A2A 层最高优先级剔除越权前缀 —— 确认维持原设计 |
| 2 | **input-required 的 UX** | P0 采用「模型转述追问」纯 tool-result 方案（结构化 text result + taskId 续传），不做专用输入框 UI；专用 UI 延后按需评估 |
| 3 | **agentKey 稳定性** | `AgentA2aRef.id` 一经创建不变、仅 `cardUrl` 可改；工具名 `a2a__<id>__send_task` 随 id 稳定，不随 URL 漂移 |
| 4 | **本地 sub-agent（P2）** | **不复用 `a2a__` 命名空间**，采用独立 `sub_agent__` 前缀，明确区分「本地 profile 内互调」与「远程网络调用」，避免调试语义混淆 |
| 5 | **多任务并发** | P0 同一远程 agent 同时只允许一个进行中任务（工具执行天然串行，agent-loop 内 `await` 逐个执行 [已验证：`agent-loop.ts:173-196`]）；跨轮恢复未竟任务（tasks/get）延至 P1 |
