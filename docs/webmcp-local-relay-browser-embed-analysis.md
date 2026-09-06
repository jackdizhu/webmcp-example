# webmcp-local-relay 浏览器端（embed iframe）深度分析

> 对象：`git-source/npm-packages/packages/webmcp-local-relay` v5.1.0（只读参考子模块）
> 关注文件：`src/browser/embed.ts`、`src/browser/widgetRuntime.ts`、`src/browser/shared.ts`、`scripts/build-widget-html.js`
> 本文档回答两个问题：① embed iframe 到底做了什么；② 页面未引入 embed.js（如仅用 HTML attr 声明 MCP 能力）时，如何实现连接。

---

## 1. 浏览器端整体结构：两个运行时、一条消息链

浏览器端不是一个脚本，而是**主世界代理（embed.js）+ 隐藏 iframe（widget.html/widgetRuntime.js）**的两层结构：

| 层 | 产物 | 运行位置 | 职责 |
|---|---|---|---|
| embed.js | `dist/browser/embed.js`（IIFE） | 宿主页面主世界（MAIN world） | 读配置、找 WebMCP 运行时、执行工具、注入 iframe、充当 iframe 的 postMessage RPC 服务端 |
| widget | `dist/browser/widget.html`（构建期由 `build-widget-html.js` 把 widget.js 包进最小 HTML 壳） | 隐藏 blob iframe 内 | 唯一的 WebSocket 持有者：端口发现、握手、断线恢复、消息转发 |

完整调用链（MCP Client 调一次工具）：

```
MCP Client (stdio)
  → LocalRelayMcpServer → RelayBridgeServer
  → WebSocket(ws://127.0.0.1:9333, subprotocol webmcp.v1) 发 {type:'invoke', callId, toolName, args}
  → widgetRuntime: requestHost('webmcp.tools.invoke') → window.parent.postMessage
  → embed.js handleInvokeRequest → document.modelContext.executeTool(tool, JSON.stringify(args))
  → 结果序列化 → postMessage 回 iframe → WebSocket 发 {type:'result', callId, result}
```

---

## 2. embed.js（页面主世界代理）逐项职责

### 2.1 配置解析（`buildRelayConfig`）
全部从 `<script>` 标签的 `data-*` 属性读取：

| 属性 | 默认 | 说明 |
|---|---|---|
| `data-relay-host` | `127.0.0.1` | 仅接受 loopback（widget 侧 `isLoopbackHost` 二次校验，非 loopback 直接拒绝启动） |
| `data-relay-port` | `9333` | 发现扫描的优先端口（hint），不是硬绑定 |
| `data-relay-id` / `data-relay-workspace` | — | 多 relay 共存时按 id/workspace 过滤 |
| `data-request-timeout` | `60000` ms | 单次工具调用超时 |
| `data-auto-connect` | `true` | iframe 加载后是否立即触发端口发现 |
| `data-debug` | 关 | 诊断日志 |

`tabId` 存 `sessionStorage`（key `__webmcp_relay_tab_id`），同一标签页刷新复用 —— 这是 registry 里同名工具去歧义（`search_ed93` 后缀）的依据。

### 2.2 iframe 注入（`injectRelayWidget`）—— 最关键的一步
1. **fetch 同目录 `widget.html`**（相对 `script.src` 解析，即 CDN 上的兄弟文件）。fetch 失败**直接失败（fails closed）**，不会静默降级。
2. 把配置序列化为 `window.__WEBMCP_RELAY_CONFIG = {...}` 注入到 `</head>` 前。
3. 打包成 **Blob URL** 创建 `<iframe>`（隐藏 + `aria-hidden` + `data-webmcp-relay="1"` 防重复注入 + `allow="loopback-network; local-network; local-network-access"`）。
4. **blob iframe 继承宿主页面 origin** → iframe 发起的 WebSocket 请求 Origin 头就是页面真实 origin → relay 端 `--widget-origin` 校验的是**浏览器保证不可伪造的 Origin 头**，而不是客户端 hello 里自报的 origin 字段。这是整个安全模型的地基。

> ⚠️ 隐含约束：自托管时必须同时伺服 `embed.js` 和 `widget.html`；跨 origin 托管时 widget.html 的 fetch 必须开 CORS。

### 2.3 postMessage RPC 服务端
只接受 `event.origin === widgetOrigin`（即本页面 origin）且 `event.source === widgetWindow` 的消息，处理三类：

- `webmcp.tools.list.request` → 调 `modelContext.getTools()` 返回工具描述列表；
- `webmcp.tools.invoke.request` → 严格按「先 `getTools()` 取回**原始 RegisteredTool 对象**，再 `executeTool(tool, JSON.stringify(args))`」执行（Chrome 要求不能传 name 或过期拷贝），结果经 `normalizeSerializedToolResponse` 归一；`resultType: 'input_required'` 的多轮结果被显式转成 isError（relay 不支持 MCP task 流程）；
- `webmcp.reload` → 直接 `window.location.reload()`（relay 发现协议漂移时让页面自愈）。

### 2.4 工具同步（去抖 + 快照去重 + 双通道）
- `toolchange` 事件监听：trySubscribe 失败（运行时未就绪）时按 100ms 起、×1.5 退避、上限 1s 重试 40 次；
- **每 2s 轮询兜底**：部分 Chromium 预览版在 AbortSignal 移除工具时不发 toolchange，轮询保证旧工具最迟 2s 内消失；
- 用 **stable-stringify 快照**（键排序递归）对比变化，没变不推 —— 避免 postMessage 风暴触发 relay 端动态工具反复重建。

### 2.5 页面可见性唤醒
`visibilitychange` → visible 时向 iframe 发 `webmcp.connect`，触发休眠中的 iframe 立即重新发现 relay。

---

## 3. widgetRuntime（iframe 内桥接运行时）逐项职责

### 3.1 端口发现（`buildDiscoveryCandidates` + `probeRelayEndpoint`）
候选顺序：hint 端口 → sessionStorage 缓存的 endpoint（key 按 `hostOrigin + relayId/workspace` 组合）→ `127.0.0.1` 与 `[::1]` × **9333~9348** 全量扫描。
每个候选：`new WebSocket(url, ['webmcp-discovery.v1', 'webmcp.v1'])`，**1.2s 内**收到合法 `server-hello`（`service === 'webmcp-local-relay'`、`version === 1`）才算命中；再校验 `relayId`/`relayWorkspace` 匹配，不匹配立即断开换下一个。命中后把 endpoint 写入 sessionStorage 缓存。

### 3.2 握手时序（严格的两段式）
```
widget → relay : hello {tabId, origin, url, title}      ← title 是先向宿主要了 tools/list 之后才发
relay  → widget : hello/accepted                          ← 1s 内不 ACK 则 widget 主动 close(4000)
widget → relay : tools/list {tools:[...]}                 ← 初始工具集
```
握手前先向宿主 `requestHost('webmcp.tools.list')` 拿初始工具列表，保证 relay 在接受 hello 后第一时间注册动态工具。

### 3.3 运行期消息
- `ping` → `pong`（relay 心跳 15s / 25s 判死，widget 无感）；
- `invoke {callId, toolName, args}` → postMessage 问宿主 → `result {callId, result}`；宿主超时（默认 60s）或出错都回 isError result，不会让 MCP Client 悬挂；
- `reload` → 转发宿主刷新。

### 3.4 断线恢复状态机（idle / discovering / dormant）
```
断开 → 500ms(±15% 抖动) 重试同一 endpoint
     → 失败则全范围重扫，间隔 10s / 20s / 30s
     → 仍失败 → dormant：
         · 停止主动重连
         · 每 2min 心跳探测（只探 hint + 缓存端口，不全扫）
         · visibilitychange 唤醒（立即全扫，计数清零）
```
命中 relayId/workspace 校验失败不会清缓存，只有 `hello/rejected` 才清缓存 —— 说明二者语义不同：前者是「不是我找的 relay」，后者是「relay 拒绝了我」。

### 3.5 为什么非要 iframe，页面直连不行吗？
协议上**可以直连**（见第 4 节路线 C），iframe 提供的是三个工程价值：

1. **可信 Origin 校验链**：blob iframe 继承页面 origin，relay 用浏览器保证的 WS Origin 头做准入；若由页面任意脚本直连，`hello.origin` 自报字段就成了唯一身份来源（relay 对无 Origin 头的客户端就是退化到自报值的）。
2. **JS 领域隔离**：WS 连接、pending 调用表、重连状态机都活在 iframe 里，页面框架的重渲染/路由切换/脚本冲突不会打断连接；页面只能通过明确定义的 postMessage RPC 影响桥接。
3. **生命周期一致**：`data-webmcp-relay` 标记防重复注入，iframe 随页面卸载自动回收 WS。

---

## 4. 缺失 embed 时如何连接（attr 声明式能力场景）

前提澄清：**WebMCP 标准里没有「纯 HTML attr 声明工具」的机制** —— `document.modelContext.registerTool()` 必须有 JS 调用；且 relay 是纯被动服务端，**没有任何反向拉取页面的通道**（`webmcp_open_page` 只能打开/刷新页面，页面侧仍须自己连上来）。所以 attr 只能当作「工具清单」数据，**必须有一个 JS 层把它翻译成 registerTool + 建立桥接**。三条路线：

### 路线 A：浏览器扩展 content script 补位（本仓库 chrome-extension 已验证的路线）✅ 推荐
```
content script (MAIN world)
  1. 解析页面 DOM 中 data-* 声明的工具清单（name/description/inputSchema/handler 引用）
  2. 注入 @mcp-b/global（或 webmcp-polyfill）→ document.modelContext.registerTool(...)
     attr 里只存 handler 名时，从 window[fnName] 取函数；纯数据型工具直接在桥接层实现 execute
  3. 建立连接：二选一
     a. 动态插一个 <script src=".../embed.js">（必须带 src，embed.ts 依赖 document.currentScript.src
        解析 widget.html 路径，inline 注入会 throw "must be loaded from a URL"）
        → 走完整 embed iframe 链路
     b. 不用 embed，走扩展自有通道：content script ↔ chrome.tabs.connect ↔ extension host
        （本仓库 main-extension/content-script.ts + TabClientTransport 即此路线）
```
要点：attr 声明 → registerTool 的翻译层要处理 handler 缺失（降级为返回说明性文本）、schema 非法（复用 embed 的「丢弃单个坏工具不影响全局」策略）、SPA 重渲染导致的 attr 变化（MutationObserver 或复用 2s 轮询思路）。

### 路线 B：自建 mini-embed（网站方可控、无扩展）
照抄 embed.ts 的四步：读配置 → 把 attr 工具清单 registerTool 到 modelContext → fetch widget.html → blob iframe 注入 + postMessage RPC。**最省事的做法**：写一个 ~50 行的适配脚本完成「attr → registerTool」，然后直接加载官方 CDN 的 `embed.js`（支持 `data-relay-port` / `data-request-timeout`），iframe 链路完全复用上游，零协议维护成本。

### 路线 C：页面直连 WebSocket（无 iframe）
页面脚本自己实现 webmcp.v1 客户端，协议要点（全部有 zod schema 可对照，见 `schemas.ts`）：
1. `new WebSocket('ws://127.0.0.1:9333', ['webmcp-discovery.v1','webmcp.v1'])`，1.2s 等 `server-hello`，扫描 9333–9348；
2. 发 `hello {tabId, origin, url, title}` → 等 `hello/accepted`；
3. 发 `tools/list {tools}`，工具变化发 `tools/changed`；
4. 收 `invoke {callId,...}` → 执行 → 回 `result {callId, result}`；回 `pong` 应 `ping`。
代价：失去 iframe 的领域隔离与安全语义（WS Origin 仍是页面 origin，可过 `--widget-origin`，但 hello 自报 origin 与真实 origin 同源无从校验差异），且需自行实现发现/缓存/重连/休眠状态机 —— 只建议在无法注入 iframe 的环境（如严格 CSP 禁 blob:、沙箱 iframe 嵌套）使用。

### 路线对比

| | A 扩展补位 | B mini-embed | C 页面直连 |
|---|---|---|---|
| 页面需改动 | 无（对页面透明） | 加 2 个 script | 加自研桥接脚本 |
| 覆盖第三方网站 | ✅（无需网站配合） | ❌ 仅自家站点 | ❌ 仅自家站点 |
| 协议维护成本 | 低（b 路线复用扩展通道） | 最低（复用上游 embed） | 高（自己实现状态机） |
| Origin 校验强度 | 取决于通道（扩展通道不依赖 Origin） | 强（blob iframe 继承） | 弱（自报 origin） |
| 适用场景 | 任意网页、批量治理 | 产品化站点接入 | 特殊 CSP/沙箱环境 |

### 补充：relay 端的三个硬约束（任一不满足即连不上）
1. `--widget-origin` 必须包含页面真实 origin（默认 `*` 放行但会打警告）；
2. 页面必须在 loopback 环境可访问的浏览器里（Chrome 147+ 跨公网站点连 localhost 会先弹 Local Network Access 权限）；
3. `taskSupport: 'required'` 的工具会被 schemas 层直接过滤，attr 清单里声明了也不会出现。

---

## 5. 与本仓库 chrome-extension 路线的对照

| 维度 | relay embed iframe | 本仓库 chrome-extension |
|---|---|---|
| 载体 | 网页内 blob iframe + WS | MV3 扩展 content script + `chrome.tabs.connect` |
| 连接方向 | 页面主动连本机 relay 进程 | 页面被动等扩展注入桥接 |
| 身份依据 | WS Origin 头（浏览器保证） | 扩展 host_permissions |
| 需要 embed.js | 是 | 否 |
| 已知坑 | widget.html fetch 失败即静默无工具（fails closed） | `TabClientTransport` 一次性握手、扩展 reload 后须刷新页面（见 MEMORY 技术陷阱） |

二者工具 schema 语义一致（同源于 `@mcp-b/webmcp-types`），registry/naming 层（同名去歧义、128 字符清洗）可直接对照复用。
