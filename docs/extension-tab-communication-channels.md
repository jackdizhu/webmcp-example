# 浏览器 tab 页签与扩展通讯方案对比分析

> 状态：定稿（2026-09-18）
> 关联：`docs/webmcp-chrome-extension-tab-invoked-agent-task-explore.md`（C5 页签反调任务，已实施）
> 结论先行：C5 已选 **`window.postMessage`（MAIN→CS）+ `chrome.runtime` Port（CS→SW→宿主）** 组合；`MessageChannel` 为 v2 升级路径；`externally_connectable` 为固定站点加速路径；其余方案明确不采用。

---

## 1. 背景与约束

### 1.1 需求特征（C5 场景画像）

| 特征 | 含义 | 对通道的要求 |
|---|---|---|
| 页面主动发起 | tab 页调用扩展能力（agent 任务 / tool 直调） | 需要「页面 → 扩展」入站通道 |
| 任意 origin | html-app（localhost:5173）及未来任意页面 | 白名单须**运行时动态**可变，不能写死 manifest |
| 长任务 | agent 任务 10 分钟级 | 需长连接 + SW 保活 + 断线补偿，不能用一次性 sendMessage |
| 结果回传 | 任务终态（completed/failed/cancelled）+ 会话 id | 需双向通道 |
| 既有基建 | CS（page-tools-bridge）、SW Port、tab-source-manager 全部在位 | 新通道复用既有传输层成本最低 |

### 1.2 世界隔离模型（为什么存在「跨墙」问题）

```text
┌─────────────── 浏览器 tab 页 ───────────────┐      ┌────── 扩展进程 ──────┐
│  MAIN world（页面 JS + 注入 SDK）           │      │  Service Worker      │
│         │  ▲                                 │      │  (agent-task-router) │
│  ═══════╪══╪══════════════════ 隔离墙 ═════  │      │         ▲ Port       │
│         │  └── 跨墙通道（本分析 A 组）        │      │         ▼            │
│  ISOLATED world（content script 桥）        │ ───► │  侧栏扩展页（宿主）   │
│              └── chrome.runtime Port（B/C 组）     └──────────────────────┘
└─────────────────────────────────────────────┘
```

- MAIN world 与 ISOLATED world 共享 DOM、共享 window 事件系统，但 **JS 堆完全隔离**（各自独立的全局对象与内建函数）。
- 页面 JS（MAIN world）**没有 `chrome.*` API**——所以「页面直达扩展」要么走跨墙两跳（A→Port），要么走浏览器特批的直达通道（B 组）。
- 下行（扩展→页签）与上行共用反向路径，无新增协议。

### 1.3 通道分组

- **A 组·跨墙通道**（MAIN ↔ ISOLATED）：`window.postMessage`、`MessageChannel`、`CustomEvent`、`BroadcastChannel`、共享存储/DOM 轮询
- **B 组·直达通道**（页面 → 扩展进程，绕过 CS）：`externally_connectable`、`chrome.debugger`（CDP）、本地服务中转
- **C 组·下行通道**（扩展 → 页签）：`tabs.sendMessage` / `tabs.connect` / `scripting.executeScript` / `postMessage`（CS→SDK）/ CDP `evaluate` / `navigator.modelContext`（声明式，方向互补）
- **D 组·扩展内部**（补充）：runtime Port、`storage.onChanged`、扩展页间 BroadcastChannel——非「tab 通讯」范畴，仅备注。

---

## 2. A 组：跨墙通道（MAIN world ↔ content script）

> A 组共性：**全部是公开信道**——页面任意脚本可监听/伪造（页面与 SDK 同住 MAIN world，无法在通道层区分）。因此信任锚必须在 SW（`port.sender` 权威注入 + `tabInvokeAllowlist` 默认拒绝），A 组选型只比「元数据、定向性、序列化、兼容性」。

### 2.1 window.postMessage ✅ 已选

**机制**：`window.postMessage(message, targetOrigin)`；CS 与页面共享同一 window，CS 侧 `window.addEventListener('message', …)` 接收；回程同路。

**优点**
- **零权限、零 manifest 改动**：任意 origin、任意页面立即可用，白名单逻辑完全由应用层（SW）掌控——与「运行时动态白名单」需求严丝合缝。
- **元数据可校验**：`event.origin`（发送方 origin）+ `event.source`（发送方 WindowProxy 引用）双字段，可做入口级校验与定向回信。
- **原生结构化克隆**：对象/Map/Set/ArrayBuffer 直接过（C5 的 `toolProps`、任务载荷零成本序列化；SDK 侧用 `structuredClone` 预检兜底）。
- **CSP 中立**：不涉及脚本加载、不依赖 eval，MV3 CSP 红线内零风险。
- **同 tab 近实时**：同步入队异步送达，微秒级。
- **标准化程度高**：HTML 规范核心 API，行为跨浏览器一致；DevTools Sources 可断点、可观测。

**缺点**
- 公开信道：页面脚本可伪造同源消息（须配合信任模型，见 §6.2）。
- 无内建回压/流控（应用层自管；C5 任务量小，不构成瓶颈）。
- 载荷必须可结构化克隆（函数/DOM 节点不可传）。
- 与 window 上其他 message 监听者混流（需 source 标记过滤——实现中用 `SDK_SOURCE`/`BRIDGE_SOURCE` 双标记 + 结构守卫）。

**适用**：同 tab 跨 world 通信的事实标准；点对点指令/事件通道。

### 2.2 MessageChannel（经 postMessage 移交）— v2 升级路径

**机制**：`new MessageChannel()` 得 port1/port2；通过 postMessage 把 port2 移交给对方（`otherWindow.postMessage(msg, target, [port2])`）；此后双方走**专用管道**点对点通信。

**优点**
- **私有点对点**：移交后的消息不经 window 事件流，页面其他脚本不可见、不可伪造（握手除外）。
- 支持转移对象（ArrayBuffer 零拷贝）、高频流不污染主事件流；可按任务多路复用（每任务一通道）。

**缺点**
- **建立仍依赖 postMessage**：首次握手公开，信任起点相同。
- 需自建生命周期管理（port 关闭检测、重连、多路复用协议）。
- 跨 world 移交行为依赖浏览器实现细节（Chrome 支持，但协议自管成本归应用层）。

**适用**：大结果分片、任务进度流、高吞吐场景。C5 当前载荷小，**预留为 v2 升级路径**（task-done 大结果 / 进度流推送时启用）。

### 2.3 CustomEvent + detail

**机制**：`window.dispatchEvent(new CustomEvent(name, { detail }))`；DOM 事件对双 world 可见，CS 监听同名事件。

**优点**：零权限；实现极简；派发同步（处理仍异步）。

**缺点**
- **无 origin/source 元数据**：来源只能靠 payload 自证（等于没有）。
- **detail 跨 world 序列化伤**：JS 堆隔离导致复杂对象历史上在另一 world 不可读，实践中须 JSON 字符串化；新版本 Chromium 行为在演进但**版本敏感**、标准化程度远低于 postMessage。
- 无任何超出 postMessage 的能力（同样公开信道）。

**适用**：几乎不推荐独立使用；仅当页面既有逻辑拦截了 message 事件时作备选。

### 2.4 BroadcastChannel

**机制**：`new BroadcastChannel(name)`；同 origin 全部上下文（含 CS 所在 ISOLATED world）广播收发。

**优点**：零权限；结构化克隆；API 简洁；**多播天然支持**（一页多上下文状态同步强）。

**缺点**
- **广播外泄**：消息送达同 origin 所有上下文（其他页签、iframe），隐私面大。
- 页面脚本与 SDK **共享同名频道**：可窃听、可伪造，且无 source 引用可校验。
- 仅同 origin；无定向投递。

**适用**：多页签状态同步类需求；不适用点对点指令通道。

### 2.5 共享存储 / DOM 轮询（localStorage · DOM data-* · IndexedDB）

**机制**：CS 与页面共享同 origin 存储/DOM；写入方落数据，读取方用 `storage` 事件、MutationObserver 或轮询感知。

**优点**：零权限；不依赖事件系统，极端环境兜底。

**缺点**
- **无推送语义**：全靠轮询或事件近似，延迟毫秒到百毫秒级。
- 页面可读写（零信任）；localStorage ~5MB 且同步 IO；IndexedDB 无跨上下文推送事件。
- 实现脏、语义弱，难以承载协议（ack/终态/重试都要自建）。

**适用**：仅作降级兜底；生产通道不推荐。

---

## 3. B 组：页面直达扩展进程（绕过 CS）

### 3.1 externally_connectable — 固定站点加速路径

**机制**：manifest 声明 `"externally_connectable": { "matches": [...] }`；页面直接 `chrome.runtime.sendMessage(extensionId, msg)` / `connect(extensionId)`；扩展侧用 `onMessageExternal` / `onConnectExternal` 接收（`sender.url`/`sender.origin` 由浏览器背书）。

**优点**
- **一跳直达 SW**：无 CS 中转，架构最简。
- **信任最强**：来源核验由浏览器完成（matches 白名单 + sender.origin 可信），通道层即安全。
- 与内部 Port API 同构（`onConnectExternal` 同样拿到 Port），协议可复用。

**缺点**
- **matches 静态写死**：URL pattern 必须包含至少二级域名，裸通配 host（`*`、`*.com`）与 `<all_urls>` 均不合法（官方规则）——动态 origin 只能逐条追加 manifest 并重载/发版扩展，与 C5「运行时 `tabInvokeAllowlist`」直接冲突。
- **无主动下行**：官方明确「扩展不能向网页发消息」——下行仅限页面已建立的 Port 上回发或 response 回调，不能随时推送。
- **sender 无 tab**：网页发起的连接 sender 只有 url/origin，无调用方页签 id（详见 `docs/externally-connectable-adoption-analysis.md` R2）。
- 官方节流配额（防滥用，MV3 文档未明确量化，需实测）。
- 声明即对所有 matches 页面开放：被任意脚本探测/滥用的面变大。
- 依赖页面感知扩展 id（本项目 manifest 已有 `key` 固定 id ✅，此项不阻塞）。

**适用**：固定合作站点、少而确定的 origin。若 html-app 未来固定域名部署，可**与现有链路并存**作为免 CS 二跳的加速路径（manifest 增加该域名即可）。

### 3.2 chrome.debugger / CDP（Runtime.addBinding + evaluate）

**机制**：`chrome.debugger.attach(tabId)` → `Runtime.addBinding(name)` 在页面 MAIN world 注入 `window.<name>` 函数 → 页面调用后扩展收到 `Runtime.bindingCalled`（payload 为字符串，含 executionContextId 可核验）；下行用 `Runtime.evaluate`。

**优点**
- MAIN world 直达扩展，**能力天花板**（全 CDP：求值、网络、DOM）。
- tabId / executionContextId 明确，来源可核验。

**缺点**
- 需 `debugger` 权限 + 每页 attach：**常驻「正在调试此浏览器」横幅**，生产 UX 不可接受。
- **独占调试器**：与 DevTools、其他调试型扩展互斥。
- attach 随导航失效需重挂；SW 休眠后需重连重挂。
- 重权限商店审核敏感。

**适用**：e2e / 自动化测试（本项目 `e2e-extension` 场景正合适）；生产通道不推荐。

### 3.3 本地服务中转（页面 fetch localhost ↔ Native Messaging / WS）

**机制**：页面 `fetch('http://127.0.0.1:<port>')` 到本地常驻服务；服务经 Native Messaging（stdio）对接扩展宿主进程，或扩展 SW 直连 `ws://127.0.0.1`。

**优点**：绕开浏览器通道限制；带宽大；跨浏览器行为一致；可承载任意复杂协议。

**缺点**
- **出浏览器安全域**：受 CORS 与 Private Network Access 约束（https 页面访问 http 本地端口的限制在持续收紧）。
- 需要用户安装本地服务进程——**部署/分发成本与扩展模型不匹配**。
- 来源核验弱（本地端口对任何本地页面开放，凭据/握手全靠应用层）。

**适用**：桌面级集成（IDE companion 类）。本项目不需要。备注：仓库既有 relay 模式（SW→relay WS）是「扩展主动外连」形态，方向相反，不构成页面入站通道。

---

## 4. C 组：扩展下行通道（扩展 → 页签）

| 通道 | 落点 | 形态 | 备注 |
|---|---|---|---|
| `chrome.tabs.sendMessage(tabId)` | CS | 一次性请求/响应 | 简单指令；无长任务能力 |
| `chrome.tabs.connect(tabId)` | CS | 长连接 Port | C5 回程复用同一 Port（router 转发） |
| `chrome.scripting.executeScript`（world:'MAIN'） | MAIN world | 一次性注入/求值 | 命令式下发，非持续通道 |
| `window.postMessage`（CS→SDK） | MAIN world | 事件 | **C5 下行已用**：`task-ack`/`task-done`/`task-error` 回传 SDK |
| CDP `Runtime.evaluate` | MAIN world | 求值 | 同 §3.2 代价 |
| `navigator.modelContext` | 声明式 | 工具暴露 | 方向互补（C1：扩展消费页面），与 C5 不冲突 |

## 5. 总对比矩阵

符号：● 强 / ◐ 中 / ○ 弱（按「通道本体」评估；组合架构的补偿单独注记）。

| 方案 | 信任安全 | 权限成本 | 数据能力 | 性能 | 生命周期可靠性 | C5 适配 | 判定 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| **postMessage + Port 组合** | ◐（+SW 重锚定补偿 → 实际强） | ● | ◐（克隆原生，可升级流式） | ● | ◐（心跳+断连补偿已自建） | ● | **已选** |
| MessageChannel（移交） | ●（移交后私有） | ● | ●（转移/流式） | ● | ◐（协议自管） | ◐ | v2 升级路径 |
| CustomEvent + detail | ○ | ● | ○（跨 world 序列化伤） | ● | ◐ | ○ | 不采用 |
| BroadcastChannel | ○（广播外泄） | ● | ◐ | ● | ◐ | ○ | 不采用 |
| 存储/DOM 轮询 | ○ | ● | ○ | ○ | ◐ | ○ | 不采用 |
| externally_connectable | ●（浏览器级核验） | ○（静态 manifest） | ● | ◐（官方节流） | ● | ◐（固定站点则 ●） | 并存加速路径 |
| chrome.debugger / CDP | ● | ○（debugger 权限） | ●（全 CDP） | ● | ◐（导航失效重挂） | ○（e2e 则 ●） | e2e 专用 |
| 本地服务中转 | ○ | ◐（本地进程） | ● | ● | ◐ | ○ | 不采用 |

## 6. 选型结论

### 6.1 为什么是 postMessage（五条核心理由）

1. **零权限零 manifest 改动**——「运行时动态白名单」只有应用层能实现，postMessage 是唯一不设通道级准入的入站方式。
2. **元数据可校验**——origin + source 双字段给了入口过滤的抓手。
3. **原生结构化克隆**——任务载荷零序列化成本。
4. **CSP 中立**——MV3 禁运行时求值的红线下零风险。
5. **与既有基建同构**——C5 四跳中仅第一跳（SDK→CS）是新桥，②③ 全部复用 Port。

### 6.2 分层信任模型（公开信道的正确打开方式）

postMessage 的可伪造性**不是缺陷而是设计前提**：

```text
SDK（无特权）──公开信道──► CS（只做结构过滤，零信任）
                                │ Port + SW 注入可信 sender（port.sender.tab.id/origin，页签自报弃用）
                                ▼
                          SW（allowlist 默认拒绝 = 真正信任边界）
                                │ Port
                                ▼
                          侧栏宿主（全量校验 + 执行）
```

### 6.3 演进路线

- **v1（已实施）**：postMessage + Port 组合，心跳保活 + 断连补偿。
- **v2 预留**：大结果分片/进度流时，由 postMessage 握手移交 `MessageChannel` 专用管道。
- **并存机会**：html-app 固定域名部署后，manifest 增加 `externally_connectable` matches 作为免 CS 二跳加速路径，`tabInvokeAllowlist` 语义不变。
- **专用场景**：e2e-extension 采用 CDP 通道做自动化，不进生产链路。
