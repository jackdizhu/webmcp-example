# 复用设计方案：chrome-extension 作为 relay 的浏览器源（零 embed 侵入）

> **实施状态（2026-09-06）：P0 + P1 已落地并验证全绿**（typecheck / lint / test 77 passed）。
> 已交付：`core/relay-source-client.ts`、`core/tab-source-manager.ts`、SW 接线、
> manifest `minimum_chrome_version: 116`、单元测试 19 例。
> P2（e2e 进 e2e-extension）待后续实施。

> 目标：页面端**不加 embed iframe、不注入任何 relay 脚本**，复用本仓库 `packages/chrome-extension`
> 已有架构，把页面 WebMCP 工具暴露给外部 MCP 客户端（Claude Desktop / Cursor 等）。
> 前置分析：`docs/webmcp-local-relay-browser-embed-analysis.md`。

---

## 1. 核心思路：扩展顶替 embed.js + widget iframe 的位置

relay 服务端（`bridgeServer` / `registry` / `naming` / `mcpRelayServer`）**一行不改**，继续以
`npx @mcp-b/webmcp-local-relay` 运行。唯一的改动是「谁充当浏览器源」：

```
                       embed 方案（放弃）                     扩展方案（本设计）
宿主页面               embed.js 注入 iframe ──WS──┐          完全不动（零侵入）
隔离世界 content script  ×                        │          listTools/callTool/toolsChanged
MV3 service worker       ×                        │          ← tabs.connect ← 每标签页 RelaySourceClient
本机 relay 进程          RelayBridgeServer ◀──────┘          RelayBridgeServer（原样复用，不改）
MCP Client               stdio                               stdio（配置不变）
```

**为什么成立**：relay 服务端只认「WebSocket + webmcp.v1 子协议 + hello/tools 消息」，它根本不关心
对端是 iframe 还是扩展 SW。而扩展现有的 content script 已经通过 `TabClientTransport` + MCP Client
拿到了页面的完整工具清单（`listTools` / `listChanged` / `callTool`）—— 这正是 embed.js 里
`getTools()/executeTool()` 那层职责的等价物，且已经是双世界桥接过的（不触页面 JS）。

---

## 2. 职责映射表：embed 方案 → 扩展方案

| embed 方案的职责 | 原实现 | 扩展方案的承接者 | 复用度 |
|---|---|---|---|
| 读页面工具清单 + 变化感知 | embed.js `getTools()` + toolchange + 2s 轮询 | content script MCP Client `listTools` + `listChanged`（已存在，见 `main-extension/content-script.ts`） | ✅ 已有 |
| 工具执行 | embed.js `executeTool(tool, args)` | content script `client.callTool()`（已存在，`page-tools-bridge.ts` 协议已支持） | ✅ 已有 |
| 工具清单/调用请求的路由 | iframe ↔ 页面 postMessage RPC | `page-tools-bridge` 协议（`listTools`/`callTool`/`toolsChanged`）原样沿用，只是调用方从侧栏换成 SW | ✅ 已有 |
| WS 连接 + 端口发现 + 握手 | widget iframe `widgetRuntime.ts` | **新增** `core/relay-source-client.ts`（SW 内运行），照抄 widgetRuntime 语义 | 🆕 移植 |
| 断线重连/休眠状态机 | widgetRuntime | 同上，一并移植进 relay-source-client | 🆕 移植 |
| tabId / 标题 / URL 元数据 | sessionStorage tabId + document.title | `chrome.tabs` API（真实 tabId / title / url，比 embed 方案更准） | ✅ 更优 |
| 安全准入 | blob iframe 继承页面 Origin | WS Origin = `chrome-extension://<id>`，relay 启动参数加白（见 §5 风险） | ⚠️ 需配置 |
| `webmcp.reload` 自愈 | `location.reload()` | `chrome.tabs.reload(tabId)` | 🆕 一行 |

**结论：真正要新写的只有一个模块** —— SW 里的 `relay-source-client.ts`（≈ widgetRuntime 的等价移植），
其余全部复用现有代码或上游 relay 原样运行。

---

## 3. 架构与消息流（每标签页一条 WS，保留 relay 的 source 模型）

```
┌─ 标签页 N ──────────────────────────────┐
│ MAIN world: 页面 MCP 运行时（polyfill）   │
│      ▲ TabClientTransport（已有）        │
│ 隔离世界: content-script.iife.js         │
│   startPageToolsBridge(client)  ← 不改   │
└──────────┬───────────────────────────────┘
           │ chrome.tabs.connect(tabId)  ← 扩展页面→content script 的正确通道（已验证）
           │ 协议：listTools / callTool / toolsChanged（原样复用）
┌──────────▼───────────────────────────────┐
│ MV3 service worker（新增编排层）           │
│  TabSourceManager：                      │
│   · tabs.onCreated/Updated/Removed 管理   │
│     N 个 RelaySourceClient（每 tab 一个） │
│   · chrome.tabs.get 取 title/url 作元数据 │
│  RelaySourceClient（≈ widgetRuntime 移植）│
│   · 扫描 9333–9348 发现 relay（1.2s 探测）│
│   · hello {tabId: 真实tabId, title, url}  │
│   · tools/list / tools/changed 转发       │
│   · invoke → tabs.connect 转 content →    │
│     result {callId} 回 WS                 │
│   · ping→pong；reload→chrome.tabs.reload  │
└──────────┬───────────────────────────────┘
           │ WebSocket ws://127.0.0.1:9333 (webmcp.v1)
┌──────────▼───────────────────────────────┐
│ RelayBridgeServer（npx，不改一行）         │
│   registry 聚合 / naming 去歧义 /          │
│   webmcp_list_sources / list_tools /      │
│   webmcp_open_page（server 模式按 origin  │
│   刷新 → 对扩展源等效 tabs.reload）        │
└──────────┬───────────────────────────────┘
            │ stdio JSON-RPC
        Claude / Cursor / 任意 MCP Client
```

**为什么每 tab 一条 WS，而不是 SW 单条 WS 聚合所有 tab**：
- relay 的 source 模型 = 一条连接一个 tabId + 一组工具 + 一份元数据；多连接聚合、同名去歧义
  （`search_ed93` 后缀）、按来源解析调用，这些 `RelayRegistry` 已经做好了，别在扩展里重做；
- `webmcp_list_sources` 能逐 tab 展示真实标题/URL，溯源体验与 embed 方案完全一致；
- 单 tab 崩溃/导航只影响自己的连接，重连范围最小。

---

## 4. 实施步骤（按依赖排序，均为纯增量，不动现有链路）

**P0 —— 打通最小闭环**
1. `core/relay-source-client.ts`：移植 `widgetRuntime.ts` 的发现/握手/收发/状态机，
   入参抽象为 `PageToolsFacade { listTools(): Promise<ToolMeta[]>; callTool(name,args): Promise<result>; onToolsChanged(cb) }`
   —— 这个接口现有 `PageToolsBridgeHandle` 天然满足对偶面，SW 侧用 `tabs.connect` + 同一套
   `PageToolsRequest/Response` 协议实现即可（content script 零改动，`onConnect` 本来就接受任意扩展上下文的 Port）。
2. SW 编排 `TabSourceManager`：`tabs.onUpdated`（导航完成→重建该 tab 客户端）、
   `tabs.onRemoved`（关闭 WS）、仅对 `https?` 页面启用；维护 `tabId → client` Map。
   SW 常驻问题见 §5-①，relay 15s 心跳会持续重置 SW 空闲计时。
3. manifest：`minimum_chrome_version` 114 → **116**（MV3 SW 支持 WebSocket 的最低版本）。

**P1 —— 对齐 embed 方案的体验**
4. `toolsChanged` → `tools/changed` 推送（现有 `notifyToolsChanged()` 广播已就位，SW 端订阅转发即可）。
5. `webmcp.reload` 消息 → `chrome.tabs.reload(tabId)`。
6. relay 启动配置固化：`--widget-origin chrome-extension://<扩展固定id>`（或联调期用默认 `*`），
   扩展 id 稳定化见 §5-②。

**P2 —— 可选增强**
7. `chrome.storage` 持久化已发现的 relay 端口（等价 widget 的 sessionStorage 缓存，跨 SW 冷启动省全扫描）。
8. 端到端测试进 `e2e-extension`：启 relay（子进程）→ Playwright 打开含工具页面 →
   用 `@modelcontextprotocol/client` InMemory/stdio 连 relay 断言工具可见可调用。

**依赖引入说明**：协议消息建议先手写类型（总共 10 个左右，对照 relay `schemas.ts`）；
若要 zod 校验可从 npm 包 import（`@mcp-b/webmcp-local-relay` 公开导出了全部
`*MessageSchema`），但注意它依赖 Node 侧 `@modelcontextprotocol/server`，需确认打包摇树干净，
不如手写轻量 —— 符合本仓库「浏览器端优先复用上游」时只取纯数据契约的口径。

---

## 5. 风险与硬约束（提前列明，均非阻塞）

1. **MV3 SW 生命周期**：SW 30s 无事件即休眠。缓解：relay 心跳 ping 15s 一次，活跃连接期间
   每条入站消息都会重置空闲计时 → 连接存续期内 SW 不会休眠；休眠只发生在「无 relay / 无 tab」时，
   此时本就该静默（对应 widget 的 dormant 状态）。需在文档记录：Chrome 116+ 才有 SW WebSocket。
2. **Origin 准入语义变化**：iframe 方案 WS Origin = 页面 origin，可按站点放行；
   SW 方案所有连接 Origin = `chrome-extension://<id>`，粒度变成「按扩展放行」。
   扩展身份由 Chrome 签发不可伪造，安全上反而更强；但 unpacked 安装时 id 随机，
   需在 manifest 固定 `key`（或用户配置页展示 id 供 relay 参数复制）。
3. **页面 CSP 不再是因素**：iframe 方案下 widget.html 的加载受页面 CSP 影响需自托管/CORS；
   SW 发起的 WS 完全绕开页面 CSP —— 这是扩展方案相对 embed 的净收益。
4. **无 polyfill 的页面没有工具**：扩展 MAIN world 注入只覆盖配置的 matches；
   页面自身未注册工具时 source 空列表（relay 对 toolCount=0 的 source 自动隐藏，
   `listSources` 过滤 `toolCount > 0`），无需处理。
5. **taskSupport/input_required 语义**：relay 端 schemas 层过滤 `taskSupport: 'required'`；
   扩展侧经 MCP `listTools` 拿到的工具描述不含 execution 字段时，等价于不过滤，
   多轮 `input_required` 结果仍由 relay 调用路径兜底报错 —— 行为与 embed 方案一致，无需额外处理。

---

## 6. 与两条既有通道的关系（不冲突，分层互补）

| 通道 | 消费方 | 状态 |
|---|---|---|
| 侧栏（panel-client ↔ page-tools-bridge） | 扩展内 AI 对话/调试 UI | 已有，保持不变 |
| relay 出口（SW ↔ 本机 relay ↔ 外部 MCP Client） | Claude Desktop / Cursor 等外部客户端 | 本设计新增 |

两条通道共享同一个 content script 的 MCP Client；`startPageToolsBridge` 的 `onConnect`
本就支持多 Port 并发（侧栏 + SW 各持一条 Port），无需互斥。
