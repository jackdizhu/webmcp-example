# web-agent-worker 探索：浏览器页面后台调用远程 Agent 接口的 Web Worker 公共库

> 状态：explore v2（待 propose）
> 日期：2026-09-19
> 决策前置：**已确认采用 Web Worker**（放弃 Service Worker——规避 SW 注册/作用域/更新/打包复杂度，vite 原生支持 `new Worker(new URL(...), { type: 'module' })`，dev/build 一致）。
> v2 补充（2026-09-19）：新增 loop-agent 能力（§9）——loop-agent 为大脑，dify-chat 注册为其可调用 tool；页面调用时注册临时回调 tool；**web-agent-worker 不依赖其他包（用户拍板，自包含移植）**。§1-§8 为 v1 dify 直调基线，协议与包结构以 §9 修订为准。

## 1. 目标与边界

| 项 | 内容 |
| --- | --- |
| 目标 | 新建 `packages/web-agent-worker` 公共库：在浏览器页面后台线程调用远程 Agent（Dify）接口 |
| 输出组装 | 按调用参数返回两种形态：`text/event-stream` 语义（增量分片流）或 `application/json`（聚合一次） |
| 配置注入 | Dify 配置（endpoint / api-key / user / inputs / responseMode / 超时）由消费方**初始化时传入**，库内零配置零环境假设 |
| 消费方 | `webmcp-html-app` 的 `src/demo/web-agent.ts`（页面调用 demo） |
| 参考 | `webmcp-agent-chat-core/src/dify-client.ts`（组包/超时/SSE 分帧/错误分型/日志红线） |

红线（对齐 dify-client / chat-core 既有惯例）：

- 零 chrome.*、零 UI、零 DOM 依赖、零 workspace 包依赖（**自包含，不 import chat-core**——延续 html-app 镜像类型策略）；
- `fetchImpl` 依赖注入（对齐 a2a-client/dify-client 先例，worker 线程内默认 `self.fetch` 裸标识符调用，测试注入桩）；
- api-key 只进 `Authorization` 头，绝不落日志/持久化；日志只记 URL/事件/状态/耗时；
- 网络数据不可信，远端结构先校验再消费。

## 2. 证据基础（已验证调用点）

| 证据 | 位置 | 结论 |
| --- | --- | --- |
| Dify 双格式解析先例 | `packages/webmcp-agent-chat-core/src/dify-client.ts`（全文 362 行） | `extractSseDataPayloads` 分帧、`createTimeoutController` 联合超时、`parseBlockingPayload` 业务错误防御、Content-Type 自适应（L222-224）、错误五分型 `A2aClientError`（invalid-url/network/http/invalid-response + 超时归一） |
| SSE 事件类型契约 | `dify-types.ts` | `message`/`agent_message` 文本分片、`message_replace` 整体替换、`message_end` 终止、`error` 流内失败、ping 等忽略 |
| 消费方构建形态 | `webmcp-html-app/package.json` + 无 vite.config | vanilla TS + vite 默认构建；`new Worker(new URL(...), {type:'module'})` dev/build 均原生支持，无需新增构建配置 |
| demo 接线惯例 | `src/demo/order-form.ts` L171-197、`src/main.ts` L44-49 | demo 导出 `buildXxxDemo(root)` 构建 UI，main.ts 挂 `#xxx-root` section 并注册工具 |
| workspace 包形态 | `webmcp-agent-chat-core/package.json` | `main`/`types`/`exports` 直接指向 `./src/index.ts`（TS 源直出，消费方 vite 编译），scripts 三闸门（test/typecheck/lint） |
| html-app 依赖隔离 | 项目记忆（2026-09-19） | html-app 不依赖 chat-core，通道工具用镜像类型 → web-agent-worker 自包含移植而非跨包引用 |

## 3. 架构方案

### 3.1 数据流

```
html-app 页面 (demo/web-agent.ts)
   │  createWebAgentClient({ worker, difyConfig })        ← 配置初始化传入
   ▼
WebAgentClient (web-agent-worker/src/client.ts，主线程)
   │  postMessage({ kind:'init', config })                ← client 自动发（ready 前 client 侧排队缓冲）
   │  postMessage({ kind:'chat', requestId, input, format:'sse'|'json' })
   ▼
Worker 线程 (src/worker/handle.ts，纯逻辑可测)
   │  handleChatRequest → fetchImpl(Dify endpoint)        ← 复刻 dify-client 组包/超时
   │  按远端 Content-Type 自适应解析（streaming 分帧 / blocking 一次解析）
   ▼
按调用参数 format 组装输出：
   format='sse'  → 逐事件 postMessage chunk(delta) … done   （SSE 增量语义）
   format='json' → 内部聚合 → 一次 postMessage done(answer)  （JSON 聚合语义）
```

### 3.2 消息协议（结构化克隆，全 JSON-able）

主线程 → worker：

| kind | 字段 | 说明 |
| --- | --- | --- |
| `init` | `config: WebAgentWorkerConfig` | 首条必发；worker 未初始化收到 chat → `error(invalid-state)` |
| `chat` | `requestId: string`、`input: { query, inputs?, conversationId? }`、`format: 'sse' \| 'json'` | requestId 由 client 生成（自增） |
| `cancel` | `requestId`（或省略 = 全部在途） | worker abort 对应 AbortController，后续该 id 分片丢弃 |

worker → 主线程：

| kind | 字段 | 说明 |
| --- | --- | --- |
| `ready` | — | worker 脚本求值完成，可收 init |
| `chunk` | `requestId`、`event`、`delta: string`、`conversationId?` | 仅 sse；`event` 为 `message`/`agent_message`/`message_replace` |
| `done` | `requestId`、`answer: string`、`conversationId?`、`durationMs?` | 终态（两种 format 通用） |
| `error` | `requestId`、`code`、`message` | 终态；code ∈ `invalid-url / network / http / invalid-response / timeout / cancelled / invalid-state` |

语义注记：

- `format='sse'` 输出的是**结构化增量分片**（已解析校验的事件），不是原始 `data: {...}\n\n` 帧；若未来需要原始帧可扩展 `raw` 字段（本期不做）。
- 远端返回 `application/json`（blocking）时，无论调用 format 为何，均直接 `done`（单结果无增量可言）。
- 组装哲学对齐 dify-client L8-9：**输出 format 只决定返回形态，远端解析一律按实际 Content-Type 自适应**。

### 3.3 配置 schema（JSONC 草案）

```jsonc
// WebAgentWorkerConfig —— 消费方初始化时传入（createWebAgentClient 入参）
{
  "dify": {
    "endpoint": "https://host/v1/chat-messages",  // 必填，HTTP(S) 校验
    "apiKey": "app-xxx",                          // 必填，仅进 Authorization 头
    "user": "webmcp-html-app",                    // 必填，Dify 契约终端用户标识
    "inputs": {},                                 // Chatflow 默认值，调用级可覆盖合并
    "responseMode": "streaming",                  // 默认 streaming；只决定 Dify 请求体
    "conversationId": ""                          // 可选默认续传；调用级 input.conversationId 覆盖
  },
  "timeouts": {
    "requestMs": 120000,   // 对齐 DIFY_REQUEST_TIMEOUT_MS
    "idleMs": 30000        // 对齐 DIFY_STREAM_IDLE_TIMEOUT_MS
  }
}
```

### 3.4 主线程 API 草案

```ts
// web-agent-worker/src/index.ts（主线程入口）
export interface WebAgentClient {
  chat(
    input: { query: string; inputs?: Record<string, unknown>; conversationId?: string },
    options?: {
      format?: 'sse' | 'json';                    // 默认 'json'
      onChunk?: (delta: string, meta: { event: string; conversationId?: string }) => void;
    },
  ): Promise<{ answer: string; conversationId?: string; durationMs: number }>;
  cancel(requestId?: string): void;               // 省略 = 取消全部在途
  terminate(): void;                              // worker.terminate()
}

export function createWebAgentClient(deps: {
  worker: Worker;                                 // 消费方创建（new URL 相对路径约束），依赖注入
  config: WebAgentWorkerConfig;                   // ← dify 配置初始化传入
  onLog?: LlmLogFn;                               // 默认 no-op，payload 不含鉴权数据
}): WebAgentClient;
```

## 4. 包结构与文件规划

```
packages/web-agent-worker/
├── README.md                    # 更新：能力说明 + 配置注入示例
├── package.json                 # name: web-agent-worker；exports: "." + "./worker"；三闸门 scripts
├── tsconfig.json                # extends base；lib 维持 ["ES2024","DOM","DOM.Iterable"]（见 4.1）
├── tsconfig.check.json          # typecheck 用（chat-core 同款）
└── src/
    ├── index.ts                 # 主线程导出：createWebAgentClient + 协议类型
    ├── client.ts                # WebAgentClient：worker 创建收发、ready 排队、requestId、chunk 回调、Promise 终态
    ├── protocol.ts              # 消息类型 + 运行时校验（双向消息不可信）
    ├── dify-protocol.ts         # 自包含移植：SSE 分帧 extractSseDataPayloads、事件校验、blocking 解析、业务错误防御
    ├── worker/
    │   ├── index.ts             # worker 线程导出：startWebAgentWorker()
    │   └── handle.ts            # handleWorkerMessage / handleChatRequest（纯逻辑：组包→fetch→解析→分片发出）
    ├── client.test.ts
    ├── protocol.test.ts
    ├── dify-protocol.test.ts
    └── handle.test.ts
```

html-app 侧：

```
packages/webmcp-html-app/
├── package.json                 # + "web-agent-worker": "workspace:*"（dependencies）
└── src/
    ├── worker/web-agent-worker-entry.ts  # new Worker 目标：startWebAgentWorker() 一行接线
    ├── demo/web-agent.ts                 # buildWebAgentDemo(root)：配置表单 + 格式切换 + 流式/JSON 输出 + 停止
    └── main.ts                           # +1 个 section 容器 + buildWebAgentDemo 接线
```

### 4.1 关键技术点

| # | 点 | 方案 | 依据 |
| --- | --- | --- | --- |
| 1 | worker 脚本打包 | 消费方持入口文件 `src/worker/web-agent-worker-entry.ts`（库只导出 `startWebAgentWorker`），`new Worker(new URL('./worker/web-agent-worker-entry.ts', import.meta.url), { type: 'module' })`；vite dev 即时编译、build 自动切独立 chunk | `new URL` 必须相对消费方源码；库保持零环境假设 |
| 2 | DOM/WebWorker lib 冲突 | **不启用** `WebWorker` lib（与 DOM 的 `self` 声明冲突 TS2403）；worker 入口用最小 structural type（`{ onmessage, postMessage }`）声明作用域 | tsconfig.base.json lib 已含 DOM；chat-core「零浏览器 API + 注入」哲学下 worker 专用全局仅存在于入口接线层 |
| 3 | worker 内 fetch | `handle.ts` deps 注入 `fetchImpl`（worker 入口默认 `self.fetch` 解构后裸调用，规避 Illegal invocation，对齐 dify-client L184-186） | 已验证先例 |
| 4 | 配置时序 | client 侧：worker 未 ready 前缓存消息队列，`ready` 后先 flush `init` 再 flush 业务；worker 侧：未 init 收 chat → `invalid-state` | 简单可靠，worker 无排队逻辑 |
| 5 | 取消 | client `cancel()` postMessage；worker 按 requestId 找 AbortController.abort()；已发分片后终止由 client 忽略晚到消息（终态已落定） | dify-client 外部 signal 语义对齐 |
| 6 | 超时 | 复刻 `createTimeoutController`（总超时 + 外部取消联合）与流内 idleTimer（空闲超时 cancel reader） | dify-client L109-127、L277-284 |
| 7 | message_replace | `event='message_replace'` 的 chunk 携带**全量替换**语义（meta.event 标记），demo 渲染层整体替换已渲染文本；`done.answer` 始终为最终全量 | dify-client L310-314 官方契约 |

## 5. demo/web-agent.ts 设计

参照 `order-form.ts` 惯例（`buildXxxDemo(root)`，样式类名前缀 `wa-`，index.html 内联样式追加）：

| 区块 | 控件 | 说明 |
| --- | --- | --- |
| 配置区 | endpoint / apiKey / user 文本框 + inputs JSON textarea + responseMode 下拉 | 仅存内存（**api-key 不落 localStorage**，安全默认）；「初始化/重建 Worker」按钮 → `new Worker` + `createWebAgentClient` |
| 请求区 | 消息输入框 + 格式 radio（流式 `text/event-stream` / JSON `application/json`）+ 发送 / 停止按钮 | 发送调 `chat(input, { format, onChunk })` |
| 会话区 | conversationId 只读展示 + 续传 checkbox | 下次请求携带 |
| 输出区 | 流式：`<pre>` 增量追加（message_replace 整体替换）；JSON：格式化一次渲染 | 附耗时/错误行 |

本期范围：**页面 UI 调用 demo**；不注册 MCP 工具（`web_agent_chat` 工具注册列为后续可选扩展，见 §8）。

## 6. 风险与待验证项（推测已标注）

| # | 风险 | 等级 | 状态 |
| --- | --- | --- | --- |
| R1 | **CORS**：Web Worker fetch 遵循与页面相同的 CORS 规则（worker 无豁免，不同于扩展 host_permissions）。页面直连 Dify 需服务端允许跨域；自部署 Dify 需 Nginx 配 CORS 头 | 高 | **推测待验证**：Dify 官方 SaaS API 是否默认开 CORS 需实测（官方 webapp 为浏览器直连场景，大概率支持）。demo 配置区加提示文案 |
| R2 | vite build 对跨包 worker chunk 的处理：html-app 依赖 workspace 包源码，worker entry 引用 `web-agent-worker/worker` 导出，build 时 rollup 需将 TS 源编译进 worker chunk | 中 | 已验证机制存在（vite 原生 worker 打包），跨包组合**待 pnpm install + build 实证**（同 vite-plus lockfile 同步经验） |
| R3 | api-key 经 postMessage 传入 worker：与主线程持有安全边界相同（同源浏览器内存），红线为不落日志/存储 | 低 | 设计约束已覆盖 |
| R4 | exactOptionalPropertyTypes 下消息字段可选语义 | 低 | 对齐 dify-client 的 `field?: T \| undefined` 写法 |

## 7. 实施步骤（propose 后执行）

1. 建包 `web-agent-worker`：package.json / tsconfig（含 check）/ README 更新；
2. `dify-protocol.ts` + 单测（SSE 分帧跨 chunk 边界 / CRLF / `[DONE]` / 业务错误防御）；
3. `protocol.ts`（消息类型 + 校验）+ 单测；
4. `worker/handle.ts`（组包/超时/解析/分片发出纯逻辑）+ 单测（fetchImpl 桩 + post 收集器 + fake timers）；
5. `worker/index.ts` 入口接线（最小 structural scope type）；
6. `client.ts`（ready 排队 / requestId / Promise 终态 / cancel）+ 单测（MessagePort 桩）；
7. html-app 接线：package.json 依赖、worker entry、demo/web-agent.ts、main.ts section、index.html 样式；
8. 三闸门：typecheck / lint / test 全绿（**pnpm install/build 由用户手动执行实证**）。

## 8. 开放问题（v1）

| # | 问题 | 默认取向 |
| --- | --- | --- |
| Q1 | 是否注册 MCP 工具（`web_agent_chat`）供 AI 调用 | 本期不做，demo 优先；后续可复用 client 一行注册 |
| Q2 | inputs 合并策略：配置级与调用级深合并还是调用级整体覆盖 | 调用级整体覆盖（与 dify-client 现行为一致） |
| Q3 | `format='sse'` + 远端 blocking JSON 的组合行为 | 直接 `done`（§3.2 注记），不做单事件伪流 |
| Q4 | 多请求并发 | worker 支持并发（requestId 隔离），demo 串行发送 |

## 9. v2 补充：loop-agent 能力（2026-09-19 需求补充）

> 需求原文：增加 loop-agent 能力，支持把 dify 注册为 tool 调用；同时支持页面调用时注册 tool 临时回调，约定调用格式，获取对话最终响应数据。
> 架构判断：**loop-agent 是大脑**（LLM tool-use 循环），**dify-chat 注册为其可调用 tool**（Dify-as-Tools，对齐 chat-core `a2a-tool-source.ts` dify 分支范式）。

### 9.1 硬约束（用户已拍板）

| # | 决策 | 内容 |
| --- | --- | --- |
| V0-1 | 自包含 | **web-agent-worker 不依赖任何 workspace 包**（chat-core 仅作移植参考，不 import） |
| V0-2 | LLM 两协议一起移植 | openai-compat + anthropic 全量移植（对齐 chat-core llm-client 行为） |
| V0-3 | 不做 A2A 协议 | 不移植 a2a-client（jsonrpc 314 行省略）；dify-as-tool 仅参考 a2a-tool-source 的 dify 分支形态 |

### 9.2 自包含移植清单（参考代码行数已核）

| 参考（chat-core/src） | 行数 | 移植为 | 说明 |
| --- | --- | --- | --- |
| `agent-loop.ts` | 220 | `src/loop/agent-loop.ts` | AgentTool / ChatMessage / ToolCallRequest / LlmChatClient / runAgentLoop / AgentAbortError / trimHistory，语义原样；**一处有意扩展**：`AgentLoopDeps` 增加可选 `listTools?: () => readonly AgentTool[]`（每轮 LLM 调用前取最新清单，缺省用 params.tools 静态清单）——支撑 V4 超时自动移除临时工具（LLM 后续迭代视野内移除），静态用法与 chat-core 完全兼容 |
| `llm-client.ts` | 392 | `src/loop/llm-client.ts` | LlmConfig + createOpenAiCompatClient + createAnthropicClient + createLlmClient 分派；阻塞式 complete |
| `dify-client.ts` + `dify-types.ts` | 362+64 | `src/dify/` | v1 已定稿（§4） |
| `a2a-tool-source.ts` dify 分支 | ~60 行等效 | `src/dify/dify-tool.ts` | 工具名/描述/入参（message/taskId）/结果文本化范式，剥离 jsonrpc |
| `a2a-client.ts` | 314 | **不移植** | V0-3 用户拍板 |

### 9.3 运行架构（推荐：loop-agent 运行在 Web Worker 线程内）

```
html-app 页面 (demo/web-agent.ts，主线程)
   │  client.runAgent({ message, tools: TempTool[] })      ← 临时回调 tool 随调用注册
   ▼  postMessage { kind:'run-agent', requestId, input, tools }
Worker 线程 (src/worker/handle.ts)
   │  装配 runAgentLoop({
   │      history: [user message],
   │      tools: [difyTools(init 注册), ...tempToolDefs(调用级)],
   │      deps: { llm(两协议 client), executeTool } })
   │
   ├─ dify tool 调用  → worker 内直连 dify-client（无跨线程）
   └─ 临时 tool 调用  → postMessage { kind:'tool-call', toolCallId, name, args }
                          ↓ 反向协议
主线程 client：查 execute 注册表 → 执行 → postMessage { kind:'tool-result', ... } → loop 继续
   ▼
完成 → postMessage { kind:'done', kind:'agent', text, transcript }   ← 对话最终响应数据
过程 → postMessage { kind:'agent-event', event }（llm_call/tool_start/tool_result/tool_error 转发）
```

推荐理由：真后台（长循环不占主线程）；与 v1 dify 直调同线程复用装配；"临时回调"天然需要跨线程协议（即"约定调用格式"）。备选：主线程 loop（临时回调退化为本地函数，无需反向协议，但失去后台语义）——见 V2。

### 9.4 消息协议扩展（v1 基线 §3.2 之上追加）

主线程 → worker：

| kind | 字段 | 说明 |
| --- | --- | --- |
| `init` | `config` 扩展为 `{ dify, llm?, loop? }` | llm 缺省时 run-agent 返回 `error(agent-disabled)`，chat 能力不受影响 |
| `run-agent` | `requestId`、`input: { message, history? }`、`tools: TempToolDef[]` | 启动 loop 任务；tools 为本任务临时工具（仅定义，执行在主线程） |
| `tool-result` | `requestId`、`toolCallId`、`content: string`、`isError?` | 主线程临时工具执行结果回传（异常经 client 捕获转 isError） |

worker → 主线程：

| kind | 字段 | 说明 |
| --- | --- | --- |
| `agent-event` | `requestId`、`event: AgentLoopEvent` | loop 过程事件转发（页面进度展示） |
| `tool-call` | `requestId`、`toolCallId`、`name`、`args` | loop 请求主线程执行临时工具 |
| `agent-accepted` | `requestId` | 受理回执（有空位即受理启动；并发满时不回此消息，直接 `error(agent-busy)`，见 §9.13） |
| `done`（扩展） | `kind: 'chat' \| 'agent'`；agent 携 `text`、`transcript: ChatMessage[]` | run-agent 的对话最终响应（含完整记录，可作下轮 history） |

取消：`cancel(requestId)` 对 run-agent 同样生效 → worker abort → loop 抛 AgentAbortError → `error(code:'cancelled')` 终态（不携带 transcript）。临时工具名与 dify 工具名冲突 → run-agent 立即 `error(invalid-state)`。并发语义见 §9.13（错误码追加 `agent-busy`；`agent-disabled` = llm 未配置）。

### 9.5 约定调用格式（临时回调 tool）

```ts
// 页面（主线程）随 runAgent 传入；生命周期 = 单次任务，完成自动失效
interface WebAgentTempTool {
  name: string;                 // 与 dify 工具名空间不可冲突
  description: string;          // 模型选型依据
  inputSchema: unknown;         // JSON Schema（AgentTool.inputSchema 同构）
  execute(args: Record<string, unknown>): Promise<unknown> | unknown;  // 主线程执行；抛异常 → isError 回填
}
```

- 执行结果 JSON 序列化回填（对齐 chat-core agent-loop `executeSingleTool`：错误也文本化回填，模型自我纠正）；
- 主线程 client 负责 tool-call 分发 / 异常捕获 / tool-result 回传（页面只写 execute 业务逻辑）。

#### 临时工具执行超时与自动移除（V4 定案，worker 侧实现）

| 项 | 定案 |
| --- | --- |
| 超时时长 | `TEMP_TOOL_TIMEOUT_MS = 60_000`（固定常量，对齐 chat-core 常量风格；可配化列演进） |
| 超时归属 | **worker 侧**：发出 tool-call 后起 60s 计时，等待 tool-result 的 Promise 超时即落定（主线程晚到的 tool-result 因 toolCallId 已不在 pending 表被静默忽略） |
| 超时行为 | ① 构造 isError 结果文本 `"临时工具 ${name} 执行超时（60s），已自动移除"` 回填 loop 继续；② `onLog('warn', 'temp_tool_timeout', { name, toolCallId, timeoutMs })` 警告日志；③ agent-event 转发 `tool_error`（页面可见；执行开始本就有 tool_start 事件） |
| 自动移除 | worker 侧把该临时工具从本任务 tempTools 注册表移除：后续迭代 `deps.listTools()` 返回过滤后清单（**LLM 视野内移除**，依赖 §9.2 agent-loop 的 listTools 扩展）；`executeTool` 对已移除名字防御返回 `"工具已移除"` 错误文本 |
| 移除范围 | 仅当前任务（临时工具本就是单任务生命周期）；dify 工具不受影响 |

### 9.6 dify-as-tool（注册为 loop 工具）

```ts
// src/dify/dify-tool.ts（参考 a2a-tool-source.ts L168-196 dify 分支，剥离 jsonrpc）
buildDifyChatTool(config: WebAgentDifyToolConfig): AgentTool
// 工具名：`dify__<id>__chat`（id 限 [a-zA-Z0-9_-]，命名空间与 a2a__ / tab<id>__ 同策略）
// 入参：message（必填）、taskId（可选 = conversationId 续传）
// 结果文本化：answer + conversationId + 续传提示（对齐 a2a-tool-source L369-380）
```

注册时机：init 配置级（`loop.difyTools`）；run-agent 不动态追加 dify 工具（见 V3）。

### 9.7 配置 schema 扩展（JSONC 草案）

```jsonc
{
  "dify": { /* v1 §3.3 原样 */ },
  // loop 大脑（可选；缺省 run-agent 不可用）
  "llm": {
    "apiKey": "",
    "baseUrl": "https://api.deepseek.com",   // 不含请求路径
    "apiPath": "/chat/completions",           // anthropic 默认 /v1/messages
    "model": "",
    "apiProtocol": "openai-compat",           // 'openai-compat' | 'anthropic'
    "maxTokens": 4096                         // anthropic 必填
  },
  "loop": {
    "systemPrompt": "",                       // 缺省内置（移植 DEFAULT_SYSTEM_PROMPT，措辞按本库语境改写）
    "maxIterations": 8,
    "difyTools": [                            // 预注册 dify 工具（worker 内直连执行）
      { "id": "sales-agent", "displayName": "", "description": "",
        "endpoint": "https://host/v1/chat-messages", "apiKey": "", "user": "",
        "inputs": {}, "responseMode": "streaming" }
    ]
  }
}
```

### 9.8 主线程 API 扩展

```ts
interface WebAgentClient {
  chat(input, options?): Promise<{ answer: string; conversationId?: string; durationMs: number }>;  // v1
  runAgent(
    input: { message: string; history?: ChatMessage[] },   // history 可选（多轮续传，不含 system）
    options?: {
      tools?: WebAgentTempTool[];                   // 临时回调工具（本任务生命周期）
      onEvent?: (event: AgentLoopEvent) => void;    // 过程进度（按 requestId 路由到本任务）
      onAccepted?: (info: { requestId: string }) => void;   // 受理回执透传（页面留存 requestId 可精确 cancel）
                                                    // 并发满时不触发（直接 reject，见 agent-busy）
    },
  ): Promise<{ text: string; transcript: ChatMessage[] }>;  // 对话最终响应数据
  cancel(requestId?: string): void;                 // 无参 = 终止全部执行中；带 id = 精确取消
  terminate(): void;                                // worker.terminate()
}
```

### 9.9 包结构 v2（修订 §4）

```
packages/web-agent-worker/src/
├── index.ts              # 主线程导出（chat + runAgent + 类型）
├── client.ts             # v1 收发 + runAgent/tool-call 分发/agent-event 转发
├── protocol.ts           # 消息类型 + 校验（v1 + §9.4 扩展）
├── dify/
│   ├── dify-client.ts    # 自包含移植（362 行参考）
│   ├── dify-types.ts     # 自包含移植（64 行参考）
│   └── dify-tool.ts      # dify→AgentTool 工厂
├── loop/
│   ├── agent-loop.ts     # 自包含移植（220 行参考）
│   └── llm-client.ts     # 自包含移植（392 行参考，两协议）
├── worker/
│   ├── index.ts          # startWebAgentWorker()
│   └── handle.ts         # chat 分支（v1）+ run-agent 分支（loop 装配 + 反向 tool 等待）
└── *.test.ts             # 测试（§10 追加）
```

html-app 侧不变（§4 末）：worker entry + demo/web-agent.ts（追加 loop 演示区：临时工具示例 + 过程事件流 + 最终响应展示）。

### 9.10 风险追加

| # | 风险 | 等级 | 状态 |
| --- | --- | --- | --- |
| R5 | llm + dify api-key 经 postMessage 进 worker 内存 | 低 | 同 R3 边界（不落日志/存储） |
| R6 | 临时工具 execute 主线程长耗时/挂起会阻塞 loop | 低 | ✅ 已缓解（V4 定案）：worker 侧 60s 超时兜底 + isError 回填 + 自动移除该工具（§9.5），loop 不会永久挂起 |
| R7 | **LLM 端点 CORS**：openai-compat/anthropic 端点同受 R1 约束（worker fetch 无豁免） | 高 | **推测待验证**：OpenAI 官方 API 支持 CORS（浏览器直连可用）；DeepSeek 等兼容端点是否开放需实测。demo 配置区提示 |
| R8 | transcript 全量回传体积（长对话） | 低 | 结构化克隆支持；本期一次性回传，分页/分片列为演进 |

### 9.11 测试计划追加（v1 §7 基础上）

- `llm-client.test.ts`：两协议请求组包（apiPath 回退/空串阻断）/响应解析（tool_calls/content null）/日志红线（payload 无鉴权）；
- `agent-loop.test.ts`：多轮 tool_calls 循环/无调用即终止/迭代上限/abort/入参 JSON 非法自愈/trimHistory 轮配对/**listTools 动态清单**（每轮取最新、缺省回退静态）；
- `handle.test.ts` 追加 run-agent 分支：llm 桩 + post 收集器模拟主线程 → 反向 tool 往返（tool-call 发出 → tool-result 注入 → 循环继续）/**临时工具 60s 超时**（fake timers：超时 isError 文本回填 + warn 日志 + 后续迭代清单移除 + 晚到 tool-result 忽略 + 已移除工具再调防御文本）；
- `dify-tool.test.ts`：工具名/描述/结果文本化/续传；
- `client.test.ts` 追加 runAgent：tool-call 分发到 execute/异常→isError/agent-event 转发/done(kind:'agent') resolve/**并发**（3 槽占满 → 第 4 个 run-agent 立即 reject(agent-busy)；任务完成释放槽位后可再发起；cancel 无参全停；cancel(id) 精确取消；onAccepted 回执时序）。

### 9.12 开放问题（v2，已全部定案）

| # | 问题 | 定案 |
| --- | --- | --- |
| V1 | LLM 协议范围 | ✅ 两协议一起移植（openai-compat + anthropic） |
| V2 | loop 运行位置 | ✅ worker 线程内（§9.3） |
| V3 | dify 工具注册时机 | ✅ init 配置级注册；run-agent 不动态追加 dify 工具 |
| V4 | 临时工具执行超时 | ✅ 60s（worker 侧计时）+ 超时警告日志 + 自动移除临时 tool（§9.5，LLM 视野内移除） |
| V5 | A2A 协议 | ✅ 不支持 |
| V6 | agent 运行中再次发起 | ✅ 并发执行，最大并发数 3；**超出直接拒绝**（agent-busy，无等待队列）（§9.13） |

> v2 开放问题已全部定案 → 进入 propose（old-vs-new diff）→ 用户放行 → apply。

### 9.14 演进项（本期不做，存档）

| # | 项 | 触发条件 |
| --- | --- | --- |
| E1 | dify 工具 per-id 串行守卫 | 出现同 conversationId 续传交叉的实际场景 |
| E2 | agent 任务级总超时（对齐 host 10min） | 长任务失控案例 |
| E3 | per-task 取消句柄（runAgent 返回 handle 对象替代 Promise） | 消费方需要更细粒度生命周期管理 |
| E4 | 临时工具超时可配（替代固定 60s） | 出现 >60s 合法长任务 |
| E5 | 超限排队语义（agent-accepted 扩 state 枚举 + FIFO 等待队列） | 消费方反馈直接拒绝体验不足 |

### 9.13 并发与队列语义（V6 定案：并发执行，最大并发数 3）

**场景**：worker 内任务正在跑 loop，页面再次发起 `run-agent`。

**方案对比（存档）**：

| 方案 | 行为 | 评价 | 先例 |
| --- | --- | --- | --- |
| 甲 直接拒绝 | 第二个 run-agent → `error(agent-busy)` | 丢请求、体验差 | a2a-tool-source 串行守卫（L524-526） |
| 乙 **并发执行** | 多 loop 并行（requestId 隔离） | ✅ 定案：能力最强；需补隔离与限流 | 无（本项目新能力） |
| 丙 FIFO 串行 | 排队等当前完成 | 被推翻（用户选并发） | agent-task-host Q9/Q11（队列 5） |
| 丁 抢占 | 新任务自动 cancel 旧任务 | 隐式取消惊讶 | 无 |

**定案（V6，2026-09-19 用户拍板）：并发执行，最大并发数 3；**超出时直接拒绝**（无等待队列）。**

| 项 | 定案 |
| --- | --- |
| 并发上限 | `AGENT_MAX_CONCURRENCY = 3`：worker 内同时最多 3 个 loop 任务执行 |
| 超限行为 | 3 槽满 → 第 4 个 run-agent **立即 `error(code:'agent-busy')`**（文案「已有 3 个智能体任务在执行，请等待完成后再发起」；对齐 a2a-tool-source 串行守卫的拒绝语义，不排队不等待） |
| 受理回执 | `agent-accepted { requestId }`（有空位即受理并启动；极简形态，队列语义已裁剪，若未来需要排队再加 state 枚举——演进 E5） |
| 槽位管理 | run-agent 到达：检查空位 → 占槽 → 启动 loop（async）；任务 finally 释放槽位（无 pump——无队列即无后续触发问题，同步单线程消息处理内占槽与启动无竞态） |
| 隔离单元 | per-task Runtime：`{ requestId, controller(AbortController), tempTools(Map), transcript, state }`——各任务 AbortController / 临时工具表 / 记录互不可见 |
| 消息路由 | `agent-event` / `tool-call` / `done` / `error` 均带 requestId，主线程按 requestId 分发到对应任务的回调 |
| 临时工具 | per-task 注册表：任务 A/B 可注册同名工具互不冲突（各自 execute 在主线程按 requestId 查表）；跨任务误路由 → 回 `tool-result(isError)` 防御 |
| dify 工具 | 全局共享（init 注册）：无状态 HTTP 并发安全；**同 conversationId 续传交叉 = 调用方责任**（per-id 串行守卫列为演进项） |
| LLM client | 无状态（complete 纯请求），多任务共享同一 config 实例 |
| cancel 精确 | `cancel(requestId)`：执行中 → abort（loop 下轮边界生效，chat-core「正在执行的工具等待完成后停止」语义一致） |
| cancel 无参 | **终止全部执行中任务**（并发下无单一"当前"概念；demo 停止按钮直觉 = 全停） |
| 精确取消的 id 来源 | `runAgent` options 增加 `onAccepted?: (info: { requestId: string }) => void` 回调（透传 agent-accepted），页面留存 requestId 后可 `cancel(requestId)` |
| chat 直调 | 不占并发槽（dify 无状态，v1 Q4 维持） |
| 任务级总超时 | 不设（maxIterations + 各环节超时封顶）——演进项 |
| 页面 demo | 每次发送生成一张任务卡片（过程事件 + 最终响应），最多 3 卡同跑可视化并发；并发满时发送 → 卡片展示拒绝文案；停止按钮 = `cancel()` 全停 |

**边界场景覆盖**：

| 场景 | 行为 |
| --- | --- |
| cancel 时 dify 调用在途 | AbortController 联合超时 → fetch abort → 错误文本化回填 → loop 下一轮 `throwIfAborted()` 抛 AgentAbortError → `error(cancelled)`（最多多跑一个工具调用距离） |
| cancel 时临时工具 execute 在主线程执行中 | worker 侧 pending 表随任务清理；晚到 tool-result 按 toolCallId 出表被忽略 |
| 任务结束释放槽位 | finally 中同步释放；新 run-agent 到达即可占槽 |
| 3 任务同名临时工具 | per-task 注册表隔离，各自 execute 独立执行 |
| 槽满瞬间页面重复点击 | 每次点击独立 run-agent → 除前 3 个外全部收到 agent-busy 拒绝（页面据此提示，不静默丢弃） |
