# 扩展关闭事件通知页签：探索稿（C7）

> 状态：✅ **已实施**（2026-09-19，与 C6 合并一次 apply 完成；实施记录见 `extension-shutdown-notify-propose.md` 文末）
> 关联：`webmcp-chrome-extension-tab-invoked-agent-task-explore.md`（C5，已实施）、`webmcp-agent-initialization-push-explore.md`（C6 推送/拉取，已实施）
> 需求原话：在浏览器扩展关闭时，调用浏览器 tab 页签通知扩展关闭事件。

---

## 0.5 需求澄清（2026-09-19 第二轮，优先级高于下文 §0-§5）

**用户补充**：①「浏览器扩展关闭」= 侧边栏**从打开状态切换到未打开状态**；② 页签注册 `web_mcp_agent_disconnect` tool 工具方法时，扩展关闭时**调用**它。

即语义收窄为**侧栏宿主生命周期事件**（原方案 D 升级为主案），且通知形态采用与 C6 相同的「页签自注册固定工具 + 扩展调用」模式（符合 Q10 红线：扩展不注册页签工具，页面自注册）。**触发链**（全部既有锚点，无拆除竞态，可靠）：

```
侧栏关闭（panel 页面销毁）
  → SW 路由 hostPort.onDisconnect（agent-task-router.ts:172-175 既有钩子；
      守卫 hostPort === port，防面板重载时 L160-162 主动 disconnect 旧 Port 的误报）
  → SW chrome.tabs.query({}) 逐页签 chrome.tabs.sendMessage(tabId, {type:'webmcp-host-status', …})
      （无 CS 页签抛 "Receiving end does not exist" → 逐个 try/catch 吞掉）
  → CS startHostStatusRelay（新模块，content-script.ts 同步注册，持 clientPromise——
      与 startAgentTaskTabBridge 同范式，不依赖 MCP 握手完成）
  → client.callTool('web_mcp_agent_disconnect', { payload })
      （复用 CS↔页面的既有 MCP 会话——该会话存活于 CS↔页面之间，面板关闭不影响它）
  → 页面 handler（自注册工具）：存快照 + 派发 CustomEvent('webmcp-agent-disconnect')
```

**要点**：

1. **信号源在 SW 路由而非垂死的面板**：面板自身 pagehide 自报（方向一）被否——拆除竞态（F3）；hostPort.onDisconnect 时刻 SW 必然存活（该事件本身即在其事件循环内），消息投递可靠。
2. **「扩展→页签调用工具」经 CS 中转达成**：SW 不自建 MCP 握手、不碰页面 modelContext；CS 持有的页面 MCP 会话（`content-script.ts` connectWithRetry 的 client）独立于面板存活，是天然的中转执行器。与 C6 推送同构、触发源不同（C6 = 面板 pusher，C7 = SW 路由）。
3. **过滤**：仅自注册了该工具的页签被调用（Q3 定手段）；工具对 agent 循环不可见（C6 Q7 同款，纳入通道工具过滤集 `AGENT_CHANNEL_TOOLS = ['web_mcp_agent_initialization', 'web_mcp_agent_disconnect']`）。
4. **恢复信号**：宿主重开 → C6 推送「首连即推」即恢复在线，不新增事件（延续原 Q5 判断）。
5. **已知边界与增强（Q7 定案：自检增强纳入）**：SW 恰在休眠瞬间面板关闭 → 主广播缺失。增强 = CS 侧 page-tools 端口断连自检——`PAGE_TOOLS_PORT_NAME`（page-tools-bridge.ts:14）是**侧栏面板 → CS 的直连 Port**，面板销毁必使其断开；CS 检测到本页全部 page-tools 端口断开后延迟 500ms 向 SW 发一次性查询（runtime.sendMessage `host-status-query`），SW 以 `chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']})` 判面板存活（Chrome 116+ 已满足，manifest 有 minimum_chrome_version），确认关闭才触发调用。覆盖面 = 全部已连接页签（不止选中页签，好于前稿预期）；reload 场景（旧 Port 断 + 新 Port 连）由 SW 存活判定天然排除。
6. **降级说明**：扩展进程级死亡（S2/S3，前稿方案 A/C 与 §1-§4 场景分析）本期不做——语义已收窄为侧栏事件，进程级死亡由 L3 拉取兜底；孤儿桥接 F5 修复仍为跨期必办（Q6）。

---

## 0. 需求理解与方向注记

「扩展关闭时通知页签」存在两种实现哲学：

- **方向一（扩展自报）**：扩展在自身关闭前**主动调用**页签（广播/callTool 页签工具）告知「我要关了」。
- **方向二（页签检测，默认推荐）**：页签侧检测「扩展不可达」（Port 断连 + 交互失败分类），扩展不（无法可靠地）自报死亡。

本稿默认按 **方向二为主 + 方向一尽力增强** 设计，理由是 MV3 生命周期硬事实（§2 F1/F3）：**死亡无法自报**——扩展被禁用/卸载/reload 时上下文先行销毁，任何「关闭前的主动通知」都是竞态下的 best-effort；而「幸存者（页签）检测连接丢失」是分布式系统的可靠范式。请 Q1 确认语义接受度。

## 1. 「扩展关闭」语义拆解（MV3 四场景）

| 场景 | 触发 | 频率 | 页签侧可见信号 |
|---|---|---|---|
| S1 SW 休眠 | ~30s 无事件即被 Chrome 回收（`service-worker.ts:3-4` 明示「随时休眠属预期」） | **常态、高频** | CS 桥接 Port `onDisconnect` 触发；下次请求自动唤醒 SW |
| S2 扩展 reload / 更新 | 手动 reload、商店更新 | 低频 | Port 断 + **CS 孤儿化**（chrome.runtime 调用抛 "Extension context invalidated"）；Chrome 会向匹配页重新注入新 CS，旧 CS 残留至导航 |
| S3 用户禁用 / 卸载 | 用户操作 | 低频 | 同 S2 孤儿化；**扩展自身无任何回调**（`onUninstalled` 只发给其他扩展） |
| S4 浏览器退出 | — | — | 页签同死，通知无意义 |

**结论**：用户感知的「扩展关闭」= S2 + S3；但 S1（休眠）在页签侧产生**相同**的 Port 断连信号，必须分类处理，否则事件高频误报。

## 2. 硬事实（置信度标注）

| # | 事实 | 置信度 |
|---|---|---|
| F1 | MV3 **无可靠的 shutdown 事件**：`chrome.runtime.onSuspend` 仅「卸载前尽力回调」，且 S1 每次休眠都触发（噪音）、S2/S3/S4 不保证触发；官方文档明示不保证 | 高（官方语义） |
| F2 | **Port 断连 ≠ 扩展关闭**：S1 休眠同样断连（本架构心跳仅在途任务运行、空闲即休眠 → 断连高频）；C5 的 `failPending`（`agent-task-tab-bridge.ts:95-100`）正依赖此信号 | 高（C5 已实证） |
| F3 | **拆除期异步外呼不可靠**：S2/S3 时扩展上下文先行销毁，关闭前向页签 Port postMessage / callTool 无投递保证；onSuspend 内发消息受同样竞态限制 | 高 |
| F4 | 死亡的**确定性信号**在孤儿化之后：CS 中任意 `chrome.runtime.*` 调用抛 "Extension context invalidated"（同步、可靠）；`chrome.runtime.getManifest()` 为同步本地读取、**不唤醒 SW**，可作「不惊眠的分类探测」 | 高 / 探测手法待实测 |
| F5 | **现有 C5 在 S2 存在悬挂坑**：孤儿桥接 `connectPort()`（`agent-task-tab-bridge.ts:85`）未 try/catch——invalidated 异常从消息监听逃逸 → SDK 请求无应答；且 `asyncCreateAgentTask` 无 SDK 侧超时 → **Promise 永久悬挂**；另有旧桥接与新注入桥接双监听 → 双应答竞态（旧桥接先回错误，落定后新应答被忽略） | 高（代码推演） |
| F6 | **复活感知天然存在**：S2 后新 CS 注入 + 新桥接懒建连；页面拉取成功 / 推送通道首连即推（C6）= 「恢复在线」信号，无需专门事件 | 高 |

## 3. 关键判断

1. **死亡不能自报**（F1/F3）→ 方向一只能做 best-effort 增强，主信号必须来自页签侧检测。
2. **事件语义 = 「不可达」+ 尽力分类**：`sw-suspended`（S1，可唤醒、临时）vs `extension-gone`（S2/S3，invalidated 证据、终态）。严格意义上的「已关闭瞬间通知」MV3 做不到（上下文可能先死），兜底 = 页面下一次交互失败的 error 分类。
3. **拉取即探活**：C6 的 `asyncAgentInitialization()` 天然是健康探测——rejected 的 `error.code` 即分类（`EXTENSION_HOST_UNAVAILABLE` / `TASK_TIMED_OUT` / `ORIGIN_NOT_ALLOWED`），**零新增机制**。
4. **「关闭」分层**：扩展进程级（S1-S3）与宿主级（侧栏关闭 = agent 能力不可用，但 SW/路由仍在）是两个不同粒度的信号，是否都纳入 = Q4。

## 4. 信号源分层

| 层 | 信号 | 来源 | 可靠性 | 噪音 |
|---|---|---|---|---|
| L1 扩展进程级 | Port 断连（+F4 分类） | CS 桥接 `onDisconnect` | 断连必达；**分类尽力**（拆除过快时广播可能发不出） | S1 休眠也触发（靠分类降噪） |
| L2 宿主级 | 侧栏宿主 Port 断/连 | SW 路由 `hostPort.onDisconnect/onConnect`（`agent-task-router.ts:171-175` 已有断连钩子） | 高（SW 存活期内必达） | 低（仅侧栏开/关时） |
| L3 请求级 | 拉取/任务失败 error.code | SDK（Q12 已有 10s 超时兜底） | 高（确定性） | 零（按需） |

## 5. 方案对比

### 方案 A（推荐主案）：桥接层断连广播 + 分类（方向二）

bridge `onDisconnect` → 延迟分类探测（F4：`getManifest()` 于 0ms/300ms 两次，不一致从严取 `extension-gone`）→ 广播 `extension-status` 给页面 → SDK 派发 CustomEvent。**顺带修复 F5 孤儿坑**（前置必需）。

| 维度 | 评价 |
|---|---|
| 覆盖 | S1/S2/S3 全覆盖；S2/S3 拆除过快时广播 best-effort，兜底靠 L3 |
| 语义 | 「不可达」+ 分类——`extension-gone` 即用户要的「扩展关闭」 |
| 成本 | protocol +1 广播消息；bridge 分类/广播/孤儿修复；SDK 事件派发 |
| 缺点 | 分类探测手法待实测（F4）；死亡瞬间通知不保证（诚实声明） |

### 方案 B（否）：onSuspend 尽力推送（方向一）

onSuspend 里向所有页签 Port 广播「即将关闭」。**否决理由**：S1 每次休眠都触发（高频噪音，且随后必然断连重复通知）；S2/S3/S4 不保证执行（F1）；拆除竞态（F3）。仅可作可观测性日志，不作功能。

### 方案 C（辅助，建议随主案启用）：拉取探测（L3）

页面按需 `asyncAgentInitialization()` 探活（任务前、visibilitychange、CustomEvent 收到 unavailable 后确认）。零新增协议，error.code 即分类。**与方案 A 是兜底关系**：A 广播丢失时，C 是唯一确定性信号。

### 方案 D（可选层，Q4 确认）：宿主级广播（L2）

router 向所有已连页签 Port 广播 `host-status: available/unavailable`（侧栏开/关）。可靠低噪、对页面最实用（「agent 能力现在可用/不可用」）；需 protocol +1 消息 + 桥接转发守卫扩展（现 `isAgentTaskHostReplyMessage` 会丢弃非应答消息）。

**组合建议**：A（主）+ C（辅，R4 复用）+ F5 修复（前置必需）；D 视 Q4；B 仅日志。

## 6. 方案 A 设计细节

**协议**（`core/agent-task-protocol.ts`）：

```ts
/** CS → 页面 的扩展状态广播（无 requestId，不进 AgentTaskHostReplyMessage 联合） */
export interface AgentExtensionStatusBroadcast {
  type: 'extension-status';
  status: 'unavailable';
  reason: 'extension-gone' | 'sw-suspended';
}
export function isExtensionStatusBroadcast(value: unknown): value is AgentExtensionStatusBroadcast;
```

**桥接**（`core/agent-task-tab-bridge.ts`）：

- `onDisconnect`（L95-100 既有 failPending 之后追加）：分类探测 `try { chrome.runtime.getManifest(); reason = 'sw-suspended' } catch { reason = 'extension-gone' }`，0ms/300ms 两次、不一致从严；`postToPage({ type: 'extension-status', status: 'unavailable', reason })`。
- **孤儿自检修复（F5）**：`onWindowMessage` 内 `connectPort()` 包 try/catch；catch 到 invalidated → 自摘除 window 监听（防与新桥接双应答）+ 回一次 `task-error(EXTENSION_HOST_UNAVAILABLE)` 落定 SDK Promise（防悬挂）。

**SDK**（`shell/agent-task-sdk.ts`）：

- message 监听**最前部**加广播分支（广播无 requestId，须先于 `isAgentTaskHostReplyMessage` 判定）→ `window.dispatchEvent(new CustomEvent('webmcp-agent-status', { detail: { status, reason } }))`。
- 可选薄 API：`onExtensionStatus(cb): () => void`（内部 addEventListener，返回退订函数）——Q2。

**html-app**：测试面板订阅 `webmcp-agent-status` → 「扩展状态」徽标（在线 / 休眠 sw-suspended / 已关闭 extension-gone）；拉取按钮失败按 error.code 归因提示（L3 兜底路径可视化）。

## 7. 改动面预估（方案 A + F5 修复）

| 模块 | 改动 | 量级 |
|---|---|---|
| protocol | `AgentExtensionStatusBroadcast` + 守卫 | 小 |
| bridge | 分类探测 + 广播 + 孤儿自检修复 | 小-中 |
| SDK | 广播分支 + CustomEvent（+ 可选 API） | 小 |
| html-app | 状态徽标 + 失败归因展示 | 小 |
| 方案 D（若纳入） | protocol +1 消息、router 广播、bridge 转发守卫 | 中 |
| 文档/测试 | 分类矩阵、孤儿修复回归、广播守卫单测 | 小-中 |

## 8. 开放问题 v2 → 定案（2026-09-19 全部确认；原 v1 Q1-Q5/Q7 已被 §0.5 收窄取代，原 Q6 孤儿修复并入下表）

| # | 问题 | **定案 ✅** |
|---|---|---|
| Q1 | 工具载荷形态 | ✅ **小载荷** `{ version: 1, event: 'disconnect', occurredAt }` |
| Q2 | 通知范围 | ✅ **仅数据源中已经连接的页签**（tab-source-manager statuses 中 state === 'connected'） |
| Q3 | 未注册该工具的页签处理 | ✅ **仅注册了工具的才调用，否则仅打印警告日志**（relay 经 client.listTools() 实时预检，零缓存时效问题） |
| Q4 | 页面消费形态 | ✅ **仅工具调用**（页面 handler 自行派发 `CustomEvent('webmcp-agent-disconnect')`；SDK 不新增任何 API） |
| Q5 | 「宿主恢复」 | ✅ **复用 C6 推送首连即推**，不新增事件 |
| Q6 | 进程级死亡与孤儿修复 | ✅ **进程级死亡本期不做**（L3 拉取兜底已覆盖）；**孤儿桥接修复（F5）随 C6/C7 apply 一并实施** |
| Q7 | SW 休眠窗口边界 | ✅ **CS 端口断连自检增强也纳入**（page-tools Port 断连 → 500ms 延迟 → SW getContexts 查询确认 → 触发同一调用链；2s 去重窗口 + 页面 handler 幂等） |
