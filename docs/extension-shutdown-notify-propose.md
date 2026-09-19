# web_mcp_agent_disconnect 宿主关闭通知：实施提案（old-vs-new diff）

> 状态：✅ **已实施**（2026-09-19，与 C6 合并一次 apply；实施记录见文末，含 **R2 复核修正**说明）。前置：探索稿 `extension-shutdown-notify-explore.md` 的 Q1-Q7 已全部确认（§8 定案表）。
> 语义（§0.5 收窄）：**侧栏宿主从打开 → 未打开** 时，扩展调用页签自注册的 `web_mcp_agent_disconnect` 工具（Q10 红线：扩展不注册页签工具，页面自注册）。
> 关联：C6 propose（`webmcp-agent-initialization-propose.md`）——两案建议**合并一次 apply**（P2/P9 与 C6 F1/F10 同文件）；孤儿桥接修复（P10）随本期一并实施（Q6 定案）。

---

## 0. 定案摘要（Q1-Q7，全部已确认）

| # | 定案 |
|---|---|
| Q1 | 小载荷 `{ version: 1, event: 'disconnect', occurredAt }` |
| Q2 | 通知范围 = **数据源中已经连接的页签**（tab-source-manager statuses 中 `state === 'connected'`） |
| Q3 | **仅注册了工具的才调用，否则仅打印警告日志**（relay 经 `client.listTools()` 实时预检，零缓存时效问题） |
| Q4 | **仅工具调用**（页面 handler 自行派发 `CustomEvent('webmcp-agent-disconnect')`）；SDK 零改动 |
| Q5 | 宿主恢复 = 复用 C6 推送首连即推，不新增事件 |
| Q6 | 进程级死亡本期不做；**孤儿桥接修复（F5）随本期 apply 一并实施** |
| Q7 | **CS 端口断连自检增强纳入**（page-tools Port 断连 → 500ms → SW `getContexts` 确认 → 同一调用链；2s 去重 + handler 幂等） |

## 0.1 双路径触发链（设计核心）

```
【主路径：SW 广播（SW 存活窗口内必达）】
面板关闭 → SW router hostPort.onDisconnect（agent-task-router.ts:171-175）
  → guard hostPort === port 分支内（L173 置 null 之后）新增 broadcastHostUnavailable()
      （reload 替换场景 L160-162 主动断旧 Port 时 hostPort 已换新 ≠ port → 不广播，天然排除误报）
  → chrome.tabs.sendMessage 逐页签（Q2：数据源已连接页签，getBroadcastTabIds 注入）
      （无 CS 页签 "Receiving end does not exist" → 回调内 consumeRuntimeLastError 吞掉）
  → CS host-status-relay（chrome.runtime.onMessage 收广播）→ handleHostUnavailable()

【增强路径：CS 端口自检（Q7，覆盖 SW 休眠窗口）】
面板关闭 → 该页全部 PAGE_TOOLS_PORT 断开（page-tools-bridge.ts:164-166 ports 清空）
  → onAllPortsDisconnected 回调（P8 新增）→ relay.notePanelPortsClosed()
  → 500ms 延迟（等 reload 场景新 Port 重连）→ chrome.runtime.sendMessage({type:'host-status-query'})
      （CS 发消息可唤醒休眠 SW；SW 重建 router 监听后处理查询）
  → SW defaultSidePanelAliveProbe：chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}).length > 0
      （Chrome 116+，manifest minimum_chrome_version 已满足；探测异常从严 reply hostAlive=true，宁可漏报不误报）
  → reply hostAlive=false → handleHostUnavailable()

【handleHostUnavailable（relay 内，两条路径汇合）】
1. 2s 去重窗口（lastNotifiedAt，Q7）
2. Q3 预检：await client.listTools() → 工具清单含 web_mcp_agent_disconnect？
     含 → callTool('web_mcp_agent_disconnect', buildAgentDisconnectPayload())
     不含 / listTools 失败 → console.warn 警告日志，不调用
3. callTool 失败 → console.warn（通知是 best-effort，不重试；下次推送/拉取差异感知兜底）
→ 页面 handler：存 lastDisconnect 快照 + window.dispatchEvent(CustomEvent('webmcp-agent-disconnect', { detail }))
```

## 1. 协议与载荷（单源定义）

```ts
// core/agent-task-protocol.ts（P1 新增；零新错误码，无 requestId、不进既有消息联合）
/** SW → CS 的宿主状态广播（chrome.tabs.sendMessage 载荷）。 */
export interface AgentHostStatusBroadcast {
  type: 'webmcp-host-status';
  status: 'unavailable';
  occurredAt: number;
}
/** CS → SW 的一次性存活查询（chrome.runtime.sendMessage；自检增强 Q7）。 */
export interface AgentHostStatusQuery { type: 'host-status-query' }
/** SW → CS 查询应答（sendResponse）。 */
export interface AgentHostStatusReply { type: 'host-status-reply'; hostAlive: boolean }
export function isAgentHostStatusBroadcast(value: unknown): value is AgentHostStatusBroadcast;
export function isAgentHostStatusQuery(value: unknown): value is AgentHostStatusQuery;
export function isAgentHostStatusReply(value: unknown): value is AgentHostStatusReply;

// chat-core（P2 新增；C6 F1 agent-init.ts 同文件增量）
export const AGENT_DISCONNECT_TOOL_NAME = 'web_mcp_agent_disconnect';
/** 通道工具全集（C6 单项泛化；Q7 不可见过滤同步覆盖两项）。 */
export const AGENT_CHANNEL_TOOL_NAMES = ['web_mcp_agent_initialization', AGENT_DISCONNECT_TOOL_NAME] as const;
export interface AgentDisconnectPayload { version: 1; event: 'disconnect'; occurredAt: number }
export function buildAgentDisconnectPayload(now?: number): AgentDisconnectPayload;
// isAgentInitChannelTool → isAgentChannelTool、excludeAgentInitTools → excludeAgentChannelTools（泛化重命名，见 §4 联动）
```

## 2. 逐文件 old-vs-new

| # | 文件 | old（现状） | new（改动） | 依据 |
|---|---|---|---|---|
| P1 | `core/agent-task-protocol.ts` | 线消息仅有任务语义（联合 L256-265 + 双守卫 L268-289） | §1 三个状态消息接口 + 三个守卫（追加在守卫区之后，不进 `AgentTaskTabMessage`/`AgentTaskHostReplyMessage` 联合——广播/查询无 requestId 语义）；**错误码零新增** | Q1/Q4 |
| P2 | chat-core `agent-init.ts`（C6 F1 同文件） | C6 定稿：`AGENT_INITIALIZATION_TOOL_NAME` + `isAgentInitChannelTool`/`excludeAgentInitTools` 单项过滤 | +`AGENT_DISCONNECT_TOOL_NAME`/`AGENT_CHANNEL_TOOL_NAMES`/`AgentDisconnectPayload`/`buildAgentDisconnectPayload`；过滤纯函数泛化为 `isAgentChannelTool`/`excludeAgentChannelTools`（实现从「单项相等」改「集合 includes」）；+单测 | Q1/通道集 |
| P3 | `core/agent-task-router.ts` | `startAgentTaskRouter(): { stop }`（L47 无参）；`hostPort.onDisconnect`（L171-175）= 消费 lastError → guard 置 null → failAllInFlight | ① 签名改 `startAgentTaskRouter(deps: AgentTaskRouterDeps = {})`：`{ getBroadcastTabIds?: () => number[]; isSidePanelAlive?: () => Promise<boolean> }`；② `broadcastHostUnavailable()`：取 `getBroadcastTabIds?.() ?? []` 逐个 `chrome.tabs.sendMessage(tabId, {type:'webmcp-host-status',status:'unavailable',occurredAt:Date.now()}, () => consumeRuntimeLastError())`；③ **onDisconnect 重排**：`if (hostPort === port) { hostPort = null; failAllInFlight(...); broadcastHostUnavailable(); }`——failAllInFlight 移入 guard（语义收紧：reload 替换不再补偿在途请求——旧宿主已被新宿主替换，在途请求由新宿主继续服务，见 §5 风险 R2）；④ `chrome.runtime.onMessage.addListener(onRuntimeMessage)` 处理 `host-status-query` → `isSidePanelAlive ?? defaultSidePanelAliveProbe`（getContexts SIDE_PANEL）→ reply；探测异常 → `hostAlive: true`（从严不误报）；`stop()` 移除该监听 | Q2/Q7/guard |
| P4 | `core/tab-source-manager.ts` | 返回对象含 `getStatuses`（L1047）、`getSelectedTabIds`（L674）；statuses Map（L620 迭代范式） | 返回对象 +`getConnectedTabIds: () => number[]`：遍历 `statuses` 取 `state === 'connected'` 的 tabId（`reconnecting` 不纳入——apply 时实测确认；主路径漏报由自检路径兜底） | Q2 |
| P5 | `shell/service-worker.ts` | L29-36 manager 在独立 try 块内、L40-44 `startAgentTaskRouter()` 无参；`SW_BUILD_TAG`（L18） | manager 实例提升至外层作用域（try/catch 兜底保留，失败时 manager 为 null → deps 降级 `() => []`）；`startAgentTaskRouter({ getBroadcastTabIds: () => manager?.getConnectedTabIds() ?? [] })`；`SW_BUILD_TAG` 更新 | Q2 装配 |
| P6 | `core/host-status-relay.ts` **新增** | 无 | `startHostStatusRelay(deps: { getClient: () => Promise<Client>; now?; dedupeWindowMs?=2000; selfCheckDelayMs?=500 }): { notePanelPortsClosed(); stop() }`：① `chrome.runtime.onMessage` 收 `isAgentHostStatusBroadcast` → `handleHostUnavailable()`；② `notePanelPortsClosed()` → `selfCheckDelayMs` 延迟 → `chrome.runtime.sendMessage({type:'host-status-query'}, cb)` → reply `hostAlive === false` 才 `handleHostUnavailable()`（lastError/超时 = 无法确认，仅 console.info）；③ `handleHostUnavailable`：2s 去重 → `getClient().listTools()` 预检（Q3：含 `AGENT_DISCONNECT_TOOL_NAME` 才 `callTool(name, buildAgentDisconnectPayload())`；未注册/失败 → `console.warn`）→ callTool 失败仅 `console.warn`；CS 端零 chrome.storage 依赖，vitest 可测（chrome stub） | Q3/Q7 |
| P7 | `main-extension/content-script.ts` | main() L88-93：`clientPromise` → `bridge = startPageToolsBridge(clientPromise)` → `startAgentTaskTabBridge()` | `const hostStatusRelay = startHostStatusRelay({ getClient: () => clientPromise })`（同步注册，与桥接同范式不依赖握手）；`startPageToolsBridge(clientPromise, { onAllPortsDisconnected: () => hostStatusRelay.notePanelPortsClosed() })`；顺序：relay 先于 bridge（回调就绪） | P6/P8 接线 |
| P8 | `core/page-tools-bridge.ts` | `startPageToolsBridge(client)`（L92 单参）；onDisconnect 仅 `ports.delete(port)`（L164-166） | 签名 +第二参 `options?: { onAllPortsDisconnected?: () => void }`；onDisconnect 内 `ports.delete` 后 `if (ports.size === 0) options?.onAllPortsDisconnected()`（最后一条面板 Port 断开才触发；面板 reload 时新 Port 重连后 size > 0，由 SW 存活判定兜底防误报）；`stop()` 不触发回调（卸载场景） | Q7 触发源 |
| P9 | html-app `src/tools/agent-disconnect.ts` **新增** + `src/main.ts` + `src/agent-task-test.ts` | main.ts L83-103 `registerAllTools` 批量注册（get_status + form_*）；agent-task-test.ts 仅任务面板 | ① 新增工具工厂 `createAgentDisconnectTool()`（`src/tools/` 与 get-status 同范式）：name=`web_mcp_agent_disconnect`、inputSchema 空对象、handler = 记录快照 + `window.dispatchEvent(new CustomEvent('webmcp-agent-disconnect', { detail: payload }))`（**页面自注册，不违反 Q10 红线**）；② main.ts `registerAllTools` +1 注册、`renderState` toolNames +1；③ agent-task-test.ts +「宿主状态」区：监听 CustomEvent → 「宿主已离线（occurredAt）」徽标 / 初始「在线」；镜像 `AgentDisconnectPayload` 类型与 chat-core 注释互指；**与 C6 F10 合并为一次改动** | Q4/Q1 |
| P10 | `core/agent-task-tab-bridge.ts`（**孤儿修复 F5，Q6 定案随本期实施**） | `connectPort()` L85 `chromeGlobal.runtime.connect(...)` 无 try/catch：扩展 reload 后旧 CS 调用同步抛 "Extension context invalidated" → 异常从 onWindowMessage 逃逸 → SDK 请求无应答且**Promise 永久悬挂**；旧/新桥接双监听双应答竞态 | connectPort 的 `runtime.connect` 包 try/catch：catch 且 `/extension context invalidated/i` → ① `window.removeEventListener('message', onWindowMessage)` 自摘除监听（本桥接退场，消除双应答）；② `failPending('EXTENSION_HOST_UNAVAILABLE', '扩展已重载，任务通道失效（刷新页面后恢复）')` 落定全部在途 Promise（含当前请求——L114-117 先入 pending 后建连）；非 invalidated 异常 → `return null`（走既有 L119-128 兜底回 task-error）；C6 `init-request` 同路径自动受益 | F5/Q6 |
| P11 | 文档 | 探索稿状态「propose 待放行」 | 探索稿 → 已实施；本提案补实施记录（含三闸门结果）；`webmcp-chrome-extension-tab-invoked-agent-task-explore.md` F5 补修复后记 | 流程 |

## 3. 测试计划

| # | 域 | 用例 |
|---|---|---|
| T1 | protocol | 三守卫：接受合法消息、拒绝缺字段/未知 type |
| T2 | chat-core | buildAgentDisconnectPayload 结构与 now 注入；`AGENT_CHANNEL_TOOL_NAMES` 两项；isAgentChannelTool 裸名/`tab1__` 前缀命中、其他工具不命中；excludeAgentChannelTools 只剔命中项 |
| T3 | router | ① 真关闭（hostPort === port）→ getBroadcastTabIds 返回值逐个 sendMessage 广播；② reload 替换（先新 Port 连入再断旧）→ **不广播**；③ 无 CS 页签 sendMessage 回调 lastError 被消费不抛；④ host-status-query → stub isSidePanelAlive=false → reply hostAlive=false；⑤ 探测抛错 → reply hostAlive=true；⑥ 未注入 getBroadcastTabIds → 空数组零广播；④ 无宿主 Port 时查询仍应答（自检恰逢 SW 冷启动） |
| T4 | host-status-relay | ① 2s 去重：窗口内两次信号仅一次 callTool；② listTools 含通道工具 → callTool(name, payload) 且 payload 符合 Q1；③ 未注册 → console.warn 且零 callTool；④ listTools 拒绝 → warn 零调用；⑤ 自检链：notePanelPortsClosed → 500ms → sendMessage 查询 → hostAlive=false → callTool；⑥ hostAlive=true / lastError → 不触发；⑦ 广播与自检汇合去重（fake timers） |
| T5 | bridge 修复 | ① runtime.connect 抛 invalidated → window message 监听被移除（后续请求不再转发）+ pending 全部收到 task-error(EXTENSION_HOST_UNAVAILABLE)（C5 悬挂回归锁）；② 非 invalidated 异常 → 当前请求回 task-error 且监听保留；③ 正常路径回归（C5 既有单测全绿） |
| T6 | page-tools-bridge | ① 最后一条 Port 断开 → onAllPortsDisconnected 恰一次；② 仍有 Port → 不触发；③ stop() → 不触发 |
| T7 | tab-source-manager | getConnectedTabIds 仅含 state === 'connected'；stopped/dormant/reconnecting 排除 |

## 4. C6 联动微调（`webmcp-agent-initialization-propose.md` 增量，建议合并 apply）

| # | 联动点 | 说明 |
|---|---|---|
| L1 | C6 F1 命名一步到位 | 若两案合并实施：chat-core 直接按泛化命名落地（`AGENT_CHANNEL_TOOL_NAMES` / `isAgentChannelTool` / `excludeAgentChannelTools`），C6 propose §1/§2/§3-F1/F8 中的 `isAgentInitChannelTool`/`excludeAgentInitTools` 字样视同替换；若 C6 先行 apply，C7 apply 时做重命名增量（实现单项相等 → 集合 includes，单测同步改） |
| L2 | C6 F10 与 P9 合并 | html-app main.ts 一次注册两个通道工具（initialization + disconnect）；测试面板两案 UI 合并改造 |
| L3 | Q6 口径注记 | C6 推送目标「已连接」= panel-client 口径（面板↔CS 页签连接）；C7 广播目标「已连接」= relay 数据源口径（Q2 定案）。两者是不同连接体系，**不混用**：C7 无法复用 panel-client（宿主已关闭），C6 无需 relay 口径。文档各自标注即可 |

## 5. 风险与回归面

| # | 风险 | 缓解 |
|---|---|---|
| R1 | getContexts 探测兼容性 | Chrome 116+（manifest `minimum_chrome_version` 已同步该约束——relay WS 同样要求）；探测异常从严 reply hostAlive=true（宁可漏报） |
| R2 | P3 ③ 将 failAllInFlight 移入 guard，行为变化：reload 替换场景在途请求不再立即补偿 | 评估：旧宿主 Port 被 L160-162 主动断开时，其应答通道已由新宿主 Port 接管（requestPorts 映射指向 tab Port 而非宿主 Port，应答经新 hostPort 路由可达）→ 补偿反而会误杀仍可完成的请求；单测锁死两种场景（T3 ①②）；若 apply 实测发现应答无法经新 hostPort 路由，则回退为「guard 外 failAllInFlight + guard 内广播」并记录 |
| R3 | 双路径重复触发 disconnect | relay 2s 去重 + 页面 handler 幂等（重复 callTool 仅覆盖快照/重复派发 CustomEvent，页面按事件消费无副作用） |
| R4 | 广播目标含休眠 relay 页签（dormant）漏报 | Q2 定案口径即 connected；dormant 页签 CS 仍活但不在通知范围——自检路径同样依赖 page-tools Port（面板连接态），口径一致；漏报由 C6 下次推送/拉取差异感知兜底（Q5/Q6 语义） |
| R5 | P10 摘监听后同页签 C5/C6 通道永久失效（扩展未 reload 的误判） | invalidated 判定字符串来自 Chrome 固定错误文案（"Extension context invalidated"）；误判仅发生于 Chrome 改文案（低概率），且该状态本就不可恢复（runtime 已死） |

## 6. 实施顺序与收尾

P2（chat-core）→ P1（protocol）→ P3（router）→ P4（tab-source-manager）→ P5（SW 接线）→ P10（bridge 孤儿修复）→ P8（page-tools-bridge）→ P6（host-status-relay 新增）→ P7（content-script 接线）→ P9（html-app，与 C6 F10 合并）→ 三闸门（typecheck / vitest / eslint，只读、绝对路径 node）→ P11 文档收尾。

手动验证清单：① 打开侧栏 + 数据源连接 html-app 页签 → 关闭侧栏 → 观察 html-app「宿主已离线」徽标（主路径）；② reload 扩展使 SW 休眠后关闭侧栏 → 自检路径触发（CS 控制台可见查询与 warn 日志）；③ reload 扩展（CS 残留）→ 页面发起 `asyncCreateAgentTask` → 立即收到 task-error 而非永久悬挂（P10 回归）；④ 页签未注册 disconnect 工具（注销批次）→ 关侧栏 → CS 控制台仅警告日志。

## 7. 实施记录（2026-09-19，与 C6 合并一次 apply）

**R2 复核修正（对 §1 P3③ 的实施偏差，重要）**：propose 原计划「failAllInFlight 移入 hostPort===port guard 内」经时序复核是**错误的**——「新宿主先连入、旧宿主断开事件后到」场景下（后连替换先 disconnect 旧 Port，随后旧 Port 的 onDisconnect 事件派发），guard 内补偿会跳过发给已死旧面板的在途请求（requestPorts 仍映射旧 Port），这些请求将永久悬挂。实施改为：**failAllInFlight 保持 guard 外**（后连替换场景在途请求同样需补偿——旧面板已死、新面板无此请求上下文），**仅 guard 内追加 broadcastHostUnavailable()**（真断开才广播，后连替换不广播的误报排除语义不变）。代码注释已标注。

**各文件落点**：
- P1/P2：protocol 新增三状态消息（不进任务联合）+ 守卫；chat-core 通道集两步泛化一步到位（L1）。
- P3：router +`getBroadcastTabIds`/`isSidePanelAlive` 可选 deps、`broadcastHostUnavailable()`（tabs.sendMessage + 回调消费 lastError）、`defaultSidePanelAliveProbe`（getContexts SIDE_PANEL）、`onRuntimeMessage` 查询应答（异常从严 hostAlive:true）、guard 语义按 R2 修正落地。
- P4：tab-source-manager +`getConnectedTabIds()`（`state === 'connected'`；reconnecting 不纳入，漏报由 CS 自检兜底）。
- P5：service-worker.ts 装配注入 `getBroadcastTabIds`（tabSourceManager 提升外层）。
- P6：`core/host-status-relay.ts`（新增）：广播监听 + `notePanelPortsClosed` 自检（500ms）+ host-status-query + 2s 去重 + Q3 listTools 预检（无 disconnect 工具即跳过）→ callTool 裸名断连工具（载荷 `buildAgentDisconnectPayload()`）。
- P8：page-tools-bridge 可选 `hooks.onAllPortsDisconnected`（最后一条 Port 断开才触发；stop() 主动 disconnect 不触发本端 onDisconnect，天然不误报）。
- P7：main-extension/content-script.ts 接线——relay **先于** bridge 注册；`onAllPortsDisconnected → relay.notePanelPortsClosed()`。
- P10：bridge `connectPort` 的 `runtime.connect` 包 try/catch；invalidated（`/extension context invalidated/i`）→ 自摘 window message 监听（防双应答）+ failPending 落定；非 invalidated → return null 走上层兜底。
- P9：与 C6 F10 合并（disconnect 工具工厂 + CustomEvent 广播 + 联调面板事件卡片）。
- **新增依赖声明**：`core/chrome.d.ts` 补 `runtime.onMessage` / `runtime.sendMessage` / `runtime.getContexts` / `tabs.sendMessage`（自持最小 chrome 类型策略）。

**三闸门**：typecheck 三包全过（含 router.test exactOptionalPropertyTypes 条件展开、sdk resolve 逆变包装两处修正）；vitest：chrome-extension 267 全绿（本提案净增：router 9、bridge 8、relay 6、SDK 5、page-tools-bridge 钩子 2、tab-source-manager 1）；eslint 三包全过。手动验证清单见 §6（四项均需真实浏览器操作，由用户执行）。
