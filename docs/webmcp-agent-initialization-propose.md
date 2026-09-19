# web_mcp_agent_initialization 推送 + 拉取：实施提案（old-vs-new diff）

> 状态：✅ **已实施**（2026-09-19，与 C7 合并一次 apply；实施记录见文末 §8）。前置：探索稿 `webmcp-agent-initialization-push-explore.md` 的 Q1-Q13 已全部确认。
> 范围红线（Q10 定案）：**扩展不在浏览器页签注册任何 tool 工具**；`window.webmcpAgent` 只含 `asyncCreateAgentTask` / `asyncAgentInitialization`，无注册能力。

---

## 0. 定案摘要（Q1-Q13，全部已确认）

| # | 定案 |
|---|---|
| Q1 | 扩展主动推送（方案 A）+ 页签主动拉取（R4）并存 |
| Q2 | agents 白名单仅 id/name/description（rules 全文、llmOverride 永不入载荷） |
| Q3 | a2aAgents 仅 id/name/protocol/enabled（cardUrl/endpoint 不入载荷） |
| Q4 | tools 含 inputSchema 全量；**每页签裁剪** = 自身裸名工具 + 扩展侧工具（不含 `tab<id>__` 前缀） |
| Q5 | 智能体/A2A/技能/当前智能体切换均重推（watch → 同一去抖） |
| Q6 | 推送目标 = 已连接 且 工具清单含该工具的页签 |
| Q7 | **不可见**：agent 循环与工具任务清单均过滤该工具（避免过度调用）；tools 调试页保留可见供人工触发 |
| Q8 | 去抖 500ms |
| Q9 | 不设隐私开关（隐私边界 = 载荷白名单 + 脱敏红线） |
| Q10 | 不代注册；红线 = 扩展不在页签注册任何工具 |
| Q11 | 方法定名 `asyncAgentInitialization`；协议线消息 `init-request` / `init-data` |
| Q12 | SDK 侧 10s 兜底超时 → reject `TASK_TIMED_OUT` |
| Q13 | 拉取无开关约束，连接后即可获取（白名单 + 宿主就绪）；错误码全复用、零新增 |

## 1. 载荷与快照（chat-core 单源）

```ts
// chat-core 新增 agent-init.ts（单源：推送与拉取共用）
export const AGENT_INITIALIZATION_TOOL_NAME = 'web_mcp_agent_initialization';

/** 快照（App 组装；tools 已按目标页签裁剪） */
export interface AgentInitSnapshot {
  agents: AgentProfile[];            // 全量档案（builder 内做白名单映射）
  activeAgentId: string | null;
  a2aRefs: AgentA2aRef[];            // a2aConfig 快照（token 本就不在其中）
  skills: readonly SkillSummary[];
  tools: AgentTool[];                // 目标页签自身工具（裸名）+ 扩展侧工具；已排除通道工具本身
}

/** 载荷（结构化克隆安全：纯 JSON） */
export interface AgentInitPayload {
  version: 1;
  pushedAt: number;
  currentAgent: { id: string; name: string } | null;
  agents: Array<{ id: string; name: string; description: string }>;
  a2aAgents: Array<{ id: string; name: string; protocol: string; enabled: boolean }>;
  skills: Array<{ id: string; name: string; description: string }>;
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
}

export function buildAgentInitPayload(snapshot: AgentInitSnapshot, now?: number): AgentInitPayload;
/** Q7：剥掉 tab<id>__ 前缀后等于通道工具名即命中 */
export function isAgentInitChannelTool(exposedName: string): boolean;
export function excludeAgentInitTools<T extends { name: string }>(tools: readonly T[]): T[];
```

**每页签裁剪说明（本提案对探索稿 §6 的细化，请重点复核）**：探索稿原文「数据相同、逐页签一次」，提案细化为——agents/a2aAgents/skills/currentAgent 四类目录各页签相同；**tools 维度按页签裁剪**：只含该页签自身工具（裸名）+ 扩展侧工具（builtin/injected 原样）。理由：合并清单会（a）把其他页签的工具名（含 `tab<id>__` 前缀）泄露给本页，（b）页面对带前缀名无法对应自身语境。页面如需调用工具，经 `asyncCreateAgentTask` 传裸名即可——宿主 `resolveToolName` 第 2 步按调用方页签前缀兜底（agent-task-host.ts:128-129）。载荷中**不含通道工具本身**（它是信道不是能力，Q7 口径延伸）。

## 2. Q7 可见性过滤设计（不可见）

- **过滤规则**：`excludeAgentInitTools`——暴露名剥 `tab<id>__` 前缀后 === `web_mcp_agent_initialization` 即剔除。
- **过滤落点（App.tsx 注入层，一处收口）**：agent 循环（chatController 的工具清单供给）与任务宿主（host `deps.listTools`）注入**过滤后**清单 → agent 循环看不到、工具任务 `resolveToolName` 解析不到（页面要初始化数据走 `asyncAgentInitialization`，不误入任务面）。
- **不过滤的消费点**：pusher 的页签扫描（要发现通道工具）、tools 调试页（保留可见，人工可手动触发验证推送 handler）。
- 行为变化提示：页签经 C5 工具任务请求 `web_mcp_agent_initialization` 将返回 `TOOL_NOT_FOUND`——这是 Q7 的预期效果，文档与 html-app 面板文案同步说明。

## 3. 逐文件 old-vs-new

| # | 文件 | old（现状） | new（改动） | 依据 |
|---|---|---|---|---|
| F1 | chat-core `agent-init.ts` **新增** | 无 | §1 全部内容（常量/类型/builder/过滤纯函数）+ 单测 | Q2/Q3/Q4/Q7；`toA2aConfigSnapshot` 白名单范式 |
| F2 | `core/agent-task-protocol.ts` | 线消息联合 create-task\|heartbeat\|cancel-task（L256-259）+ 双守卫（L268-289）；错误码全集 L48-60 | +`AgentTaskInitRequestMessage{type:'init-request',requestId}`、+`AgentTaskRoutedInitRequestMessage{...+sender}`、+`AgentTaskInitDataMessage{type:'init-data',requestId,payload:AgentInitPayload}`；`AgentTaskTabMessage`/`isAgentTaskTabMessage`、`AgentTaskHostReplyMessage`/`isAgentTaskHostReplyMessage` 各 +1 分支；**错误码零新增** | R4/Q13 |
| F3 | `shell/agent-task-sdk.ts` | `WebMcpAgentSdk` 单方法（L41-51）；pending Map L67-70；监听 L72-94（ack 忽略/done resolve/error reject） | +`asyncAgentInitialization(): Promise<AgentInitPayload>`：无入参（无 structuredClone 预检）→ postMessage `{source, type:'init-request', requestId}` → 复用 pending；监听 +`init-data → resolve(payload)` 分支；**10s 兜底超时**（Q12）→ reject `AgentTaskSdkError('TASK_TIMED_OUT')`，落定即清定时器 | Q11/Q12 |
| F4 | `core/agent-task-tab-bridge.ts` | onWindowMessage 仅 `create-task` 入 pending + 心跳（L114-117） | `init-request` 与 `create-task` 同路（条件扩一分支）；应答侧「非 ack 即 pending.delete」（L86-94）零改动；失联补偿 L95-100 自动覆盖 | R4 |
| F5 | `core/agent-task-router.ts` | onTabMessage 仅 `create-task` 走闸门转发（L93-137） | +`init-request` 分支：**复用**白名单闸门（L115-118）与宿主可用性检查（L119-122）→ requestPorts 登记 → 注入 sender（`AgentTaskRoutedInitRequestMessage`）转发；宿主应答路由（L164-170）「非 ack 即释放」零改动 | R4/Q13 |
| F6 | `side-panel/runtime/agent-task-host.ts` | connect 监听仅 `isRoutedCreate → acceptTask`（L515-518）；deps L59-80 | +`isRoutedInitRequest` 守卫 + 处理分支：`getInitSnapshot(sender.tabId)` → `buildAgentInitPayload` → reply `init-data`；构建异常 → `task-error EXECUTION_FAILED`；deps +`getInitSnapshot: (tabId: number) => Promise<AgentInitSnapshot>`；**不触碰** acceptTask/队列/会话建档；工具清单过滤在 App 注入层完成，host 零过滤逻辑 | R4/Q7 |
| F7 | `side-panel/runtime/agent-init-pusher.ts` **新增** | 无 | `createAgentInitPusher({ listConnectedTabs, getTabToolNames, callTool, getInitSnapshot, onLog }) → { schedule, dispose }`：`schedule()` → 500ms 去抖合并（Q8）→ 对「已连接 + 清单含通道工具」页签（Q6）逐个 `callTool('tab<id>__web_mcp_agent_initialization', { payload })`（载荷按页签裁剪）；失败 → logEvent 不重试（下次触发自然重试） | Q5/Q6/Q8 |
| F8 | `side-panel/App.tsx` | 工具合成链（L319-327, 635-658）；onStatusChange/onToolsChange 订阅（L666-677） | ① 组装 `getInitSnapshot(tabId)`：agents/activeAgentId/a2aRefs/skills 来自既有 store 缝；tools = 扩展侧工具 + panel-client 该页签裸名工具，先过 `excludeAgentInitTools`；② host deps + getInitSnapshot；③ agent 面清单过滤：chatController 与 host 的 `listTools` 供给包 `excludeAgentInitTools`（Q7）；④ 创建 pusher + 订阅接线：首连 + listTools 首成、onToolsChange、Q5 watch（agentProfileStore.agents/activeAgentId、a2aConfig、技能供给源）→ `pusher.schedule()`。行号以 apply 实测为准 | Q5/Q6/Q7 |
| F9 | `side-panel/runtime/panel-client.ts` | 每页签工具清单内部持有（rebuildRoutes 合并加 `tab<id>__` 前缀，L4-10, 556-566） | 暴露只读 accessor：每页签裸名工具名清单（供 pusher 扫描与快照组装）；若内部已有 per-tab 结构则仅加读取方法 | Q6/每页签裁剪；以 apply 实测为准 |
| F10 | html-app `main.ts` + `agent-task-test.ts` | main.ts 经 polyfill 注册 get_status 等（L91-93 范式）；测试面板按钮硬编码 agentName/toolName | main.ts + 注册 `web_mcp_agent_initialization`（handler = 存快照 + `CustomEvent('webmcp-agent-initialization', { detail })`，与 SDK 默认 handler 范式同构——注意：此为**页面自注册**，不违反 Q10 红线）；测试面板 +「拉取初始化数据」按钮（`asyncAgentInitialization()` → JSON 展示）+「最近一次推送」事件展示；镜像类型（`WebMcpAgentSdk` + `AgentInitPayload`）与 SDK 注释互指 | R1/R4 |
| F11 | 文档 | 探索稿状态「待放行」 | 探索稿状态 → 已实施；本提案补实施记录（含三闸门结果） | 流程 |

> html-app 是否直接 import chat-core 常量：apply 时以 package.json 依赖实测为准；无依赖则镜像常量 + 注释互指（与 SDK 镜像类型同范式）。

## 4. 测试计划

| # | 域 | 用例 |
|---|---|---|
| T1 | chat-core | buildAgentInitPayload **脱敏矩阵**：llmOverride（含 apiKey）不出现在 agents 任何条目；rules 不出现；a2a 条目无 cardUrl/endpoint/token；currentAgent 缺失 → null；tools 不含通道工具本身；同输入 → 同输出（双路一致断言） |
| T2 | chat-core | isAgentInitChannelTool：裸名 / `tab1__` 前缀 / 其他工具 → false；excludeAgentInitTools 只剔除命中项 |
| T3 | protocol | 双守卫接受 init-request/init-data、拒绝未知 type；requestId 缺失拒绝 |
| T4 | bridge | init-request 转发 + pending/心跳；Port 断开 → init-request 在途收到 task-error(EXTENSION_HOST_UNAVAILABLE) |
| T5 | router | init-request：白名单拒绝（ORIGIN_NOT_ALLOWED）/ 宿主不可用（EXTENSION_HOST_UNAVAILABLE）/ 放行 + sender 注入 + requestPorts 登记；init-data 按 requestId 回投 + 释放 |
| T6 | host | init-request → init-data（stub getInitSnapshot）；builder 抛错 → task-error(EXECUTION_FAILED)；acceptTask 回归不受影响 |
| T7 | SDK | init-data → resolve(payload)；10s 超时 → reject TASK_TIMED_OUT；task-error → reject（失联补偿路径） |
| T8 | pusher | 触发矩阵（首连 / onToolsChange / Q5 watch）；500ms 去抖合并；Q6 过滤（未连接/无工具页签跳过）；callTool 失败仅日志 |

## 5. 风险与回归面

| 风险 | 缓解 |
|---|---|
| App.tsx 接线点多（订阅/watch/双清单过滤），误伤手打对话与任务链 | host 既有 12 单测 + chat-core 227 单测护航；过滤仅包「agent 面供给」两处，其余消费点不动 |
| panel-client per-tab 清单若无现成结构，accessor 需小改 rebuildRoutes 附近 | apply 时先读实测，仅加只读方法不改既有行为 |
| Q7 过滤需覆盖全部 agent 面工具清单来源 | apply 时 grep 全部 `listTools` 消费点逐一核对（chatController / host / 其他） |
| 推送风暴 | 去抖 500ms（Q8）+ 触发源天然低频（连接/清单/目录变更）；推送不改变工具清单 → 无回环（探索稿 §3.2 已证） |

## 6. 实施顺序与收尾

chat-core（F1）→ protocol（F2）→ SDK（F3）→ bridge（F4）→ router（F5）→ host（F6）→ pusher（F7）→ App 接线（F8/F9）→ html-app（F10）→ 三闸门（typecheck / vitest / eslint，只读、绝对路径 node）→ 文档收尾（F11）+ 手动验证清单（reload 扩展 → 白名单页签 → 观察推送日志与 html-app 面板 → 测试拉取按钮 → agent 循环确认不可见）。

## 7. C7 联动微调（2026-09-19 追加；详见 `extension-shutdown-notify-propose.md` §4）

C7（`web_mcp_agent_disconnect` 宿主关闭通知）propose 已定稿，与本提案存在同文件交集，**建议两案合并一次 apply**：

| # | 联动点 | 对本提案的影响 |
|---|---|---|
| L1 | 通道工具集单项 → 两项（C7 P2） | F1 的 `isAgentInitChannelTool`/`excludeAgentInitTools` 泛化为 `isAgentChannelTool`/`excludeAgentChannelTools`（`AGENT_CHANNEL_TOOL_NAMES = ['web_mcp_agent_initialization', 'web_mcp_agent_disconnect']`）：合并实施时一步到位；若本提案先行 apply，C7 apply 时做重命名增量。过滤落点（§2）与单测断言同步扩展 |
| L2 | html-app 注册合并（C7 P9 ↔ F10） | main.ts 一次注册两个通道工具（initialization + disconnect）；测试面板 UI 两案合并改造；`AgentInitPayload` 之外新增镜像 `AgentDisconnectPayload` |
| L3 | 「已连接」口径区分 | 本提案 Q6 推送目标 = panel-client 口径（面板↔CS 连接）；C7 广播目标 = relay 数据源口径（Q2 定案）。两者是不同连接体系，不混用——本提案实施不受影响，仅文档各自标注 |
| L4 | 孤儿桥接修复（C7 P10） | 随 C7 一并实施（Q6 定案）；F4 的 `init-request` 转发路径自动受益（悬挂坑消除） |

## 8. 实施记录（2026-09-19，与 C7 合并一次 apply）

**实施顺序**：chat-core（F1，泛化一步到位）→ protocol（F2/P1）→ SDK（F3）→ bridge（F4/P10）→ router（F5/P3）→ tab-source-manager（P4）→ SW（P5）→ host（F6）+ pusher（F7）→ page-tools-bridge（P8）+ relay（P6）+ content-script（P7）→ App/panel-client（F8/F9）→ html-app（F10/P9）→ 三闸门。

**各文件落点与偏差**：
- `chat-core/agent-init.ts`（新增）：`AGENT_CHANNEL_TOOL_NAMES` 两项、`stripTabToolPrefix`（正则 `/^tab\d+__/`）、`buildAgentInitPayload`（a2a name = `displayName ?? id`，与 a2a-tool-source 工具清单同口径）、builder 内置 `excludeAgentChannelTools` 兜底过滤（第二道防御）。
- `protocol`：六消息接口（init-request / routed-init-request / init-data + C7 三状态消息）；守卫口径 = type + requestId 结构性最小校验（payload 深度校验在消费方，与 create-task 一致）。
- `host`：deps +`getInitSnapshot(tabId)`；`isRoutedInitRequest` 守卫 + `handleInitRequest`（异常 → task-error EXECUTION_FAILED）；**不触碰 acceptTask/队列**。connect 监听扩双分支。
- `agent-init-pusher.ts`（新增）：500ms 去抖、Q6 双条件过滤（panel-client `listConnectedTabIds` + `listTabToolNames` 含通道裸名）、单页签失败仅日志不重试。
- **F8 实施细化**：App `getInitSnapshot(tabId)` 组装 = 全量清单按 `/^tab\d+__/` 拆分——本页签暴露名还原裸名 + 非页签命名空间全局工具；agents/a2a/skills 直接取响应式源（`profileStore.agents` / `a2aConfig` / `BUILTIN_SKILLS`）。pusher 订阅：watch（agents deep + activeAgentId + a2aConfig）+ onToolsChange + onStatusChange → `schedule()`。
- **F9 扩展**：panel-client 新增 `listTabToolNames(tabId)`（缓存优先、缺失拉取一次、失败返回空数组）与 `listConnectedTabIds()`（Port 在线页签）两个只读 accessor，双层 wrapper 透传。
- **agent 面双清单过滤**：chatController.getTools 与 host.listTools 均经 `excludeAgentChannelTools`；tools 调试页不过滤（联调可直调通道工具）。
- html-app：`tools/agent-init.ts` / `tools/agent-disconnect.ts` 工厂（execute 入参放宽为 unknown 以兼容 polyfill `WebMcpToolInput`，载荷校验由 is* 守卫承担）；main.ts 注册 +2（CustomEvent `webmcp-agent-init-push` / `webmcp-agent-disconnect` 广播）；联调面板 +③ 拉取按钮与事件卡片。
- **新增依赖声明**：`core/chrome.d.ts`（自持最小 chrome 类型）补 `runtime.onMessage` / `runtime.sendMessage` / `runtime.getContexts` / `tabs.sendMessage` 四项（本工程策略：新增 API 在此补充声明）。

**三闸门**：typecheck 三包全过（chat-core 修 1 处测试工厂形状：`AgentSkillRef = {id, enabled}` 无 name）；vitest：chat-core 238 / chrome-extension 267 / html-app 45 全绿（本提案净增：agent-init 11、pusher 6、html-app 工具 8）；eslint 三包全过。
