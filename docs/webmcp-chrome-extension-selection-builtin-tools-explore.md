# webmcp-chrome-extension 需求探索：页签连接全局化 + LLM HTTP 协议 + 内置 Tools

> 状态：**已实施（apply-change 完成，2026-09-12）**。验证：typecheck / lint / test（**187/187**，含 R5.2 / R5.3 / R5.1 各轮追加用例）全绿；
> dist 经 watch 构建已含全部新能力（SW 构建标记 `global-tab-selection + builtin-tools (2026-09-12)`）；
> 注意：`side-panel.html` 为静态资源，watch 的 `onSuccess` 不重复拷贝，样式改动需重新执行一次构建（或手动同步）。
> 实现对齐说明：`reset-selection` 已作为独立协议消息落地（§3.1 决策记录保留）；
> 同名工具去歧义采用 `tab<id>__<toolName>` 前缀方案（全部冲突实例统一加前缀）。
> 追加（R5.2，2026-09-12）：内置工具接入 tools 调试页 + 调试页参数说明面板，见 §4.4。
> 修复（R5.3，2026-09-12）：内置工具结果统一包装为 MCP CallToolResult（裸数组曾被 relay 判非法并降级为 isError），见 §4.5。
> 变更（R5.1 修订，2026-09-12）：文档内容形态由「sanitize 后的 HTML」改为**元素结构大纲**，
> 入参 `includeHtml` → `includeOutline`、返回字段 `html` → `outline`；**大纲在页面内由活体 DOM 生成**，
> 无标签过滤；非文本子树（svg/canvas/media/script/style 等）**默认排除**、`includeNonTextElements=true` 可保留。见 §4.6。
> 优化（R5.1 二次修订，2026-09-12）：大纲层级改由**深度数字前缀**表达（`<depth> <selector>`，零前导空白），
> 移除「已跳过非文本节点」汇总行（内容污染）；实测 36,089 → 9,832 字符（-73%）。见 §4.6.1。
> 补齐（R5.1 三次修订，2026-09-12）：大纲**内联直接文本节点**（此前 `el.children` 遍历丢失全部文本，
> 页面语义随骨架一同丢失）；格式升级为「`深度 选择器 文本`」，单节点 80 字符、全页文本预算 8000 字符
> （耗尽追加说明行）。见 §4.6.2。
> 证据标注：【已验证】= 已对照源码确认；【推断】= 基于源码与 Chrome 行为的推测，需实现前复核。
> 日期：2026-09-11（探索）～ 2026-09-12（实施）

---

## 0. 需求清单（原始输入）

| # | 需求 | 备注 |
| ---- | ---- | ---- |
| R1 | 页签开关调整为**全局生效**：agent、tools 调试、relay 端共用 | 现状三端不统一 |
| R2 | 打开插件后取到**第一个激活页签**后不再跟随切换，改连需**手动切换** | 取消自动跟随 |
| R3 | 默认只连接第一个激活页签，后续页签需**手动开启连接** | 与 R2 同组语义 |
| R4 | 新增 LLM 大模型 API 的 **HTTP 协议支持** | 已收窄：仅 openai-compat + anthropic 两个协议（见 §3） |
| R4.1 | baseUrl 为 **http 协议**时报 CORS 跨域错误，需支持 http baseURL | **已移除（2026-09-12 用户决策）**：安全优先，不支持通用 http（见 §3.1） |
| R5 | 新增**内置 tools** | 见 §5 |
| R5.1 | `chrome_extension_get_document_info`：获取当前激活页签文档信息，**以数组返回，每个元素一个文档信息对象** | 数组语义见 §4.3（Q4 已定）；内容形态见 §4.6（结构大纲 + 非文本默认排除） |
| R5.2 | 内置工具需在 **tools 调试页**可用；调试界面**展示参数信息**，便于构造合法入参 | 2026-09-12 追加，设计见 §4.4 |

---

## 1. 现状梳理：三条「页签连接」通道

### 1.1 侧栏 agent 对话 / tools 调试（panel-client）

【已验证】`main-extension/side-panel/panel-client.ts`

- `defaultPortFactory()`（L97-103）：每次连接都 `chrome.tabs.query({ active: true, currentWindow: true })` → `tabs.connect`，**永远连当前活动页签**。
- L310-319 `onTabActivated`：监听 `tabs.onActivated`，切换页签即断开旧 Port 并重连新页面 —— **自动跟随行为**。
- 断线指数退避重连（1s→15s），首条响应才置在线（L224-247）。
- **没有任何选择状态持久化**：侧栏重开后重新取「当时的活动页签」。

### 1.2 relay 端（SW 编排层）

【已验证】`core/tab-source-manager.ts`

- 选择状态 `RelayTabSelection`（`core/relay-status-protocol.ts` L13-21）：
  - `mode: 'auto'`：仅选中当前活动页签，**随 onActivated 自动跟随**（tab-source-manager L913-923 `onActivated` 处理器）；
  - `mode: 'manual'`：侧栏 RelayPage checkbox 多选集合，不随切换变化。
- 持久化：`chrome.storage.local.relayTabSelection`（L195-217）；未选中页签不建 SW→relay WS（L799-808 选择门控）。
- `selectionInitPromise` 启动竞态保护（L476, L577）；stale tabId 清理（L514-539, L925-933）。
- relay 状态经 `startRelayStatusPort`（L1070+）推送侧栏，含 `set-selection` 请求通道。

### 1.3 结论：现状缺口

| 端 | 连接目标 | 跟随切换 | 选择状态 |
| ---- | ---- | ---- | ---- |
| agent 对话 | 活动页签 | ✅ 自动跟随 | ❌ 无 |
| tools 调试 | 活动页签 | ✅ 自动跟随 | ❌ 无 |
| relay 端 | auto=活动页签 / manual=多选 | auto ✅ 跟随 | ✅ 持久化 |

三端各自为政，R1 要求统一为一套全局选择；R2/R3 要求取消「跟随」，改为「首连 + 手动切换」。

---

## 2. R1+R2+R3 设计方案（同一组改动，合并设计）

### 2.1 目标语义

1. **单一事实源**：全局页签选择只存一份 —— SW `tab-source-manager` 的 selection（已有持久化与竞态保护，复用）。
2. **初始化**：管理器启动（SW 冷启动 / 侧栏首次打开触发）时，取**当时**的活动页签作为唯一选中项；此后 `onActivated` **不再跟随**。
3. **手动切换**：侧栏 RelayPage checkbox（或新增切换入口）改选 → 全端生效：
   - relay 端：现有 reconcileSelection 门控逻辑不变；
   - agent / tools 调试：panel-client 重连到新选中页签。
4. 默认单选（R3）；是否保留多选能力 → 开放问题 Q2。

### 2.2 改动点

| 文件 | 改动 | 级别 |
| ---- | ---- | ---- |
| `core/tab-source-manager.ts` | 删除 `onActivated` 自动跟随分支（L913-923）；auto 语义改为「初始化一次」；`getSelection`/`setSelection` 保留 | 核心 |
| `core/relay-status-protocol.ts` | `RelayTabSelection` 语义注释更新；如去 auto/manual 双模式则简化为 `{ tabIds: number[] }`（协议消息 `selection` / `set-selection` 同步调整）；新增 `reset-selection` 请求（侧栏打开时触发重置，Q5） | 协议 |
| `main-extension/side-panel/panel-client.ts` | 移除 `onTabActivated` 自动跟随（L310-319）；**单 Port 升级为多 Port 编排**（每选中页签一条连接，listTools 合并 / callTool 按页签路由，见 §5.1） | 核心 |
| `main-extension/side-panel/App.ts` | 订阅 `relayStatusClient.onSelectionChange` → 驱动 panel-client 重连目标；选中为空时置离线提示 | 编排 |
| `main-extension/side-panel/pages/RelayPage.ts` | checkbox 文案/交互对齐新语义；「恢复默认」改为「重置为当前活动页签」（发起新的初始化） | UI |
| 单测 | `tab-source-manager.test.ts`（onActivated 用例改写）、`panel-client.test.ts`（跟随用例删除、按 tabId 连接用例新增） | 测试 |

### 2.3 关键细节与风险

- 【已验证】tabId 跨浏览器重启不稳定：selection 持久化里的旧 tabId 已有 stale 清理（tabsApi.get 失败剔除）；初始化语义下每次「重置」都重新取活动页签即可。
- 【已验证·Q5 决策落地】重置触发点 = **侧栏生命周期**：侧栏 `onMounted` 经 relay-status 端口新增 `reset-selection` 请求 → SW 将选中集合重置为「当时的活动页签」（单选）并广播 selection。注意两点：
  1. 重置会**覆盖手动多选集合**（含 checkbox 勾选）——「侧栏重开 = 回到默认单选」是本次决策的直接推论，propose 阶段确认交互文案提示；
  2. SW 冷启动（浏览器重启）时的 `initSelection` 本就取活动页签，与 Q5 语义一致；持久化仅保留 SW 运行中重启的自愈价值，可在 propose 阶段评估是否简化。
- 【已验证】侧栏与 SW 的选择竞态：复用现有 `selectionInitPromise` 模式，panel-client 重连需等待 SW selection 首次推送后再动手。
- 【推断】panel-client 移除跟随后的断线重连：重连仍按「当前选中 tabId」直连（而非重查活动页签），否则重连会静默漂移回活动页签 —— 这是最容易漏的回归点。
- 【推断】选中页签导航（onUpdated complete）后 panel-client 的 Port 死亡重连目标不变，仍为该 tabId —— 现有退避重连天然满足，仅需确认 `portFactory` 持有 tabId。

---

## 3. R4：LLM API HTTP 协议支持（已决策：协议适配器）

【已验证】现状 `main-extension/side-panel/llm-client.ts`：仅实现 **OpenAI 兼容 chat completions**（`POST {baseUrl}{apiPath}`，Bearer 鉴权，`choices[0].message` / `tool_calls` 协议）。设置页已有 apiKey / baseUrl / apiPath / model 四项。

**决策（Q3，2026-09-11 23:55 收窄）**：走解读 A「协议适配器」，且**协议范围收窄为两个主流协议**：`openai-compat`（现状保留）+ `anthropic`（Messages API）。Gemini / Ollama native / 通用 HTTP 模板均不做。

**改动点**：`llm-client.ts` 拆 `createLlmClient(config)` 分发器 + 两个协议 adapter；`PanelSettings` 增加 `apiProtocol` 字段（storage 键 `llmApiProtocol`，缺省 `openai-compat` 兼容存量配置）；SettingsPage 增加协议下拉（OpenAI 兼容 / Anthropic 二选一）。

Anthropic 适配器要点【推断，实现前对照官方文档复核】：

- 端点：`POST {baseUrl}/v1/messages`（apiPath 字段对 anthropic 协议给出对应默认值，如 `/v1/messages`）；鉴权头为 `x-api-key` + `anthropic-version`（非 Bearer）。
- 请求体：`max_tokens` 为**必填**（OpenAI 协议可选）—— `PanelSettings` 需补 `maxTokens` 设置项（建议默认 4096，仅 anthropic 协议消费）；`system` 独立于 messages 数组（现有 loopOptions.systemPrompt 需按协议拆出）。
- 工具调用映射：请求侧 `tools[].input_schema`（非 `parameters`）；响应侧 `content[]` 中的 `tool_use` block（`id`/`name`/`input` 为对象非 JSON 字符串）需转换为内部 `ToolCallRequest`（`function.arguments` 序列化为 JSON 字符串）；工具结果以 user 消息 `tool_result` content block 回传。agent-loop 的消息结构与 OpenAI 协议对齐，转换层放在 anthropic adapter 内，`agent-loop.ts` 零改动。

### 3.1 http 协议 baseUrl：不支持（2026-09-12 决策，安全优先）

**决策**：移除「host_permissions 增加 `http://*/*`」支持项，**不支持通用 http 协议 baseUrl**，manifest 权限面保持现状。保留根因记录供排查参考：

【已验证·根因】配置 `http://` 协议 baseUrl 报 CORS 错误的根因在 manifest 权限面，属**预期安全行为**而非缺陷：

- `shell/manifest.json` L12 `host_permissions = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]` —— 通用 `http://*/*` 缺失。MV3 扩展页面（侧栏）的 fetch 仅对 host_permissions 已授权的主机豁免 CORS，其余主机遵循页面级 CORS 规则；非 localhost 的 http 端点因此被拦。
- 该限制**有意保留**：broad http host 权限会扩大安装告警与商店审核面，且明文 http 传输 API Key 存在嗅探风险，安全收益大于可用性收益。https 端点与本地开发端点（`http://localhost` / `http://127.0.0.1`，host_permissions 已覆盖）均不受影响。

**仅保留一处低风险修正**：`llm-client.ts` L2 注释「扩展页面上下文无 CORS 限制」改为条件化表述（仅 host 权限覆盖的主机豁免 CORS），纯注释改动、不涉及任何权限变更，避免后续维护者误判。

---

## 4. R5：内置 tools 设计

### 4.1 定位

内置 tools = **扩展自身提供**的工具（区别于页面注册的 WebMCP 工具），需回答「暴露给谁」：

| 方案 | agent 对话 | tools 调试页 | relay 端 | 评价 |
| ---- | ---- | ---- | ---- | ---- |
| A 仅侧栏 | ✅ | ✅ | ❌ | 改动小，外部 MCP 客户端看不到 |
| B 仅 relay | ❌ | ❌ | ✅ | 侧栏 agent 反而用不了，不合理 |
| C 统一注册表，双端合并 | ✅ | ✅ | ✅ | 一份定义两处生效，推荐 |

**推荐 C**：新增 `core/builtin-tools.ts`（纯逻辑 + 执行器注入），agent-loop 的 `executeTool` 前置分发，`tab-source-manager` 的 facade 在 `listTools` 结果前合并内置描述、`callTool` 优先路由内置名。

【已验证】合并点均存在清晰缝位：agent-loop.ts `AgentLoopDeps.executeTool`（L54-58）；relay 侧 `createPortToolsFacade` 返回的 `RelayToolsFacade`（tab-source-manager L266-400）。

### 4.2 R5.1 `chrome_extension_get_document_info`

- 目标页签：建议对齐 R1 语义 = **当前选中页签**（需求原文「当前激活页签」，二者在默认场景一致，见 Q1）。
- 实现通道【推断】：SW/侧栏（扩展上下文）已有 `tabs` + `scripting` 权限（shell/manifest.json L11 已验证），经 `chrome.scripting.executeScript({ world: 'MAIN' })` 注入收集函数提取文档信息，无需改 content script 协议；备选：page-tools-bridge 新增请求类型（改动面大，不推荐）。
- 返回建议 schema（单元素为「文档信息对象」）：

入参（`includeOutline` / `includeText` / `includeNonTextElements` 均为**可选开关，默认 false 不携带**，防止无效大字段污染上下文；2026-09-11 需求补充，2026-09-12 改名并新增第三开关）：

```jsonc
// inputSchema
{
  "type": "object",
  "properties": {
    "includeOutline": { "type": "boolean", "description": "返回页面元素结构大纲（缩进树，见 §4.6），默认 false" },
    "includeText": { "type": "boolean", "description": "返回清洗 + 空白压缩后的正文纯文本，默认 false" },
    "includeNonTextElements": { "type": "boolean", "description": "大纲是否保留非文本子树（svg/canvas/math、媒体与外部嵌入、script/style 等）；默认 false = 排除以节省空间" }
  },
  "additionalProperties": false
}
```

返回（单元素为「文档信息对象」；`outline` / `text` 仅在对应入参为 true 时存在）：

```jsonc
{
  "tabId": 123,
  "url": "https://…",
  "title": "…",
  "readyState": "complete",
  "characterSet": "UTF-8",
  "contentType": "text/html",
  "doctype": "html",
  "viewport": "width=device-width, …",
  "lang": "zh-CN",
  "meta": { "description": "…", "keywords": "…" },
  "counts": { "domNodes": 1234, "links": 56, "images": 7, "scripts": 3, "iframes": 1 },
  "headings": [{ "level": 1, "text": "…" }],
  "outline": "0 html\n1 head\n2 meta\n2 title 页面标题\n1 body#app\n2 div.container",  // 仅 includeOutline=true
  "text": "…清洗 + 空白压缩后的正文纯文本…"                                            // 仅 includeText=true
}
```

### 4.2.1 HTML 内容清洗与文本压缩（2026-09-11 需求补充）

> **⚠️ 本节已被 §4.6 取代（2026-09-12）**：`html`（sanitize 后的 HTML）方案因「清洗功能不达标」被否决，
> 改为**页面内生成元素结构大纲（缩进树）**，入参 `includeHtml` → `includeOutline`、返回 `html` → `outline`。
> 本节保留原设计记录仅供回溯；`text`（正文纯文本）路径不变，仍走 sanitize-html。

原设计：文档信息对象可按调用参数选带当前 HTML 文档内容（`includeHtml` / `includeText`，默认 false），处理管线：原始 `document.documentElement.outerHTML` → **sanitize-html 清洗** → 按需产出：

- `html`：清洗后的 HTML（剥离 script/style/事件属性/iframe 等危险内容，保留文档结构），**截断上限**（建议 32k 字符，propose 定值）；
- `text`：清洗后进一步**压缩为纯文本**（去标签 → 折叠连续空白 → 截断，建议 8k 字符），供 LLM 直接消费，避免大 HTML 爆上下文。
- 【推断】入参为 true 时才注入收集 `outerHTML`（页面内取原文可按需跳过），双保险控制传输与清洗开销。

实现要点【推断，需 propose 复核】：

1. **清洗发生在扩展上下文，不在页面内**：`chrome.scripting.executeScript` 注入的收集函数是序列化执行，无法携带 npm 依赖 —— 页面内只负责取 `outerHTML` 原文，sanitize-html 清洗在调用方（SW / 侧栏）完成。
2. **sanitize-html 是 Node 生态库**（依赖 htmlparser2 等，无 DOM 依赖），vite 可打包进浏览器 IIFE，但体积可观（估 100KB+ 量级）：SW 与侧栏两处 IIFE 产物都会增重，propose 阶段需确认可接受，或评估 DOMPurify 等等价替代（功能语义以 sanitize-html 为准）。
3. 清洗配置（允许标签白名单、剔除属性、保留文本的标签集合）作为 `core/builtin-tools.ts` 内置常量，双端共用同一份配置保证 agent 与 relay 结果一致。

### 4.3 数组语义（开放问题 Q4）

「以数组返回，每个元素为一个文档信息对象」三种解读：

1. **主文档 + iframe 子文档**：每个 frame 一个元素（需遍历 frame tree）；
2. **多选中页签各一个元素**：与 R1 全局多选联动，单选时数组长度 1；
3. 仅当前页签一个元素的数组（预留未来扩展）。

### 4.4 R5.2 内置工具的调用入口与调试体验（2026-09-12 需求补充）

**需求**：① 内置工具 `chrome_extension_get_document_info` 也要能在 **tools 调试页**（不经 LLM 手动执行）使用；② 调试页需**展示参数信息**，方便用户构造符合 schema 的入参。

【已验证】实施前缺口：内置工具仅在 agent 对话侧生效 —— `App.ts` runTurn 里 `mergeBuiltinWithPageTools()` 合并清单 + `executeTool` 内联 `isBuiltinTool()` 拦截；`DebugPage` 直接用 `props.pageTools.listTools()` / `callTool()`，看不到也调不到内置工具。双处各自拦截属于**行为漂移隐患**。

**设计（单一事实源）**：把内置工具合成收进侧栏工具客户端层 —— `panel-client.ts` 新增 `attachBuiltinTools(pageTools, context)`：

| 方法 | 语义 |
| ---- | ---- |
| `listTools()` | `mergeBuiltinWithPageTools(await pageTools.listTools())`（内置在前；页面工具占用 `chrome_extension_*` 命名空间时剔除，内置优先） |
| `callTool(name, args)` | 内置名 → `executeBuiltinTool(name, args, context)`（扩展上下文执行）；其余透传页面工具客户端 |
| 连接语义（`setTargetTabs` / `onStatusChange` / `onToolsChange` / `disconnect`） | 全量委托底层客户端，保持多页签编排语义不变 |

`App.ts` 改为 `pageTools = attachBuiltinTools(connectPageTools(), { getSelectedTabIds: () => relaySelection.value.tabIds })`，agent 与 tools 调试页**共用同一实例**；原先 runTurn 内的清单合并与 `executeTool` 拦截一并移除。

**调试页参数说明**（`debugger-core.ts` 新增纯函数，可单测）：

- `describeInputSchema(schema)` → `ToolParameterDescriptor[]`（`name` / `type` / `required` / `description` / `enumValues` / `hasDefault` / `defaultValue`，按 `properties` 声明顺序）；类型标签支持多类型（`integer | null`）与数组递归（`array<string>`）；schema 非法或无 `properties` → 空数组 = 「该工具无需参数」。
- `buildArgsTemplate(schema)` → 参数模板对象：优先 schema `default`，否则按类型占位（boolean→false、number→0、array→[]、object→{}、string→''）；调试页「**填入参数模板**」按钮把模板序列化进参数编辑器，让用户从合法骨架起步。
- 渲染：工具下拉下方新增「参数说明」面板（参数名 / 类型 / 必填徽标 / 默认值 / 说明 / 枚举取值）。对 `chrome_extension_get_document_info` 表现为 `includeOutline`、`includeText`、`includeNonTextElements` 三个可选 boolean（默认 false）。

【已验证】`PageToolMeta.inputSchema` 与 `BuiltinToolDescriptor.inputSchema` 结构兼容（前者 `unknown`、后者 `Record<string, unknown>`），故合并清单可直接供调试页渲染，无需额外适配层。

### 4.5 R5.3 缺陷修复：内置工具结果必须包装为 MCP CallToolResult（2026-09-12）

**现象**：内置工具 `chrome_extension_get_document_info` 经 relay 调用（外部 MCP 客户端）恒为失败，返回文本
`Tool returned an invalid result (expected {content: [...]})`；同页面的 `form_get_schema` 等页面工具正常。

**根因链路**（逐层已核实）：

| # | 位置 | 行为 |
| ---- | ---- | ---- |
| 1 | `core/builtin-tools.ts` `executeBuiltinTool` | 直接 `return entries`（裸 `DocumentInfoEntry[]`） |
| 2 | `core/tab-source-manager.ts` facade / `main-extension/side-panel/panel-client.ts` | 两个内置路由点均 `Promise<unknown>` 原样透传 |
| 3 | `core/relay-source-client.ts` `handleInvoke` → `sendResult(result)` | 裸数组经 WS 发给 relay |
| 4 | relay `src/bridgeServer.ts` `normalizeCallToolResult` | `CallToolResultSchema.safeParse` 失败 → 包装为 `{isError: true}` 诊断结果 |

页面工具之所以正常：页面侧 WebMCP polyfill 已把 handler 返回值包装成
`{content: [{type:'text', text: JSON.stringify(result)}]}`，只有内置工具这条路缺了这层包装。

**修复**（单点收敛，两处路由点无需改动）：

- `core/builtin-tools.ts` 新增类型 `BuiltinToolResult`（MCP CallToolResult 形态：`{content: [{type:'text', text}], isError: false}`）与包装函数 `toBuiltinToolResult(payload)`；
- `executeBuiltinTool` 返回类型由 `Promise<unknown>` 收紧为 `Promise<BuiltinToolResult>`，唯一 return 点改为 `toBuiltinToolResult(entries)`；
- 语义保持：单页签失败仍以元素内 `error` 字段表达、整体 `isError: false`（不阻断其余页签）。

**副作用与对齐**：内置工具与页面工具结果从此**同构** —— agent 循环（`JSON.stringify(result)` 作为 tool 消息）、调试页（`serializeToolResult` 提取 content 文本块）都无需分支处理两种形状；relay 端 `normalizeCallToolResult` 的降级分支不再被内置工具命中。

### 4.6 R5.1 修订：文档内容形态改为「元素结构大纲」（2026-09-12）

**背景**：原 `includeHtml` 产出「sanitize 清洗后的 HTML」，实测**清洗效果不达标** —— 白名单过滤后仍夹杂大量属性/无关标签，用户希望的形态是
`div#id.className` + `div子元素` 这样的**元素结构大纲**（每行一个元素、层级清晰），而非近似原始 HTML 的片段。
初版采用缩进树，实测缩进占 82.7% 字符，遂改为**深度数字前缀**（§4.6.1）。

**决策与落地**（三轮对齐 + 体积优化）：

| # | 结论 | 说明 |
| ---- | ---- | ---- |
| 1 | 形态 = **元素大纲**（每行一个元素） | 格式 `<深度> <选择器> [文本]`；选择器为 `tag#id.class1.class2`（无 id/class 时仅 tag）；文本为元素**直接文本节点**（见 §4.6.2）；**根为 `html` 元素、深度 0**（`document.documentElement ?? document.body`） |
| 2 | 改名 `includeHtml` → `includeOutline`、返回 `html` → `outline` | 名称与新形态一致；`html` 白名单（原 `SANITIZE_OPTIONS`）**已删除**，不再做标签过滤 —— 从 `html` 节点起保留所有元素 |
| 3 | 非文本子树**默认排除**，可经参数保留 | 新增 `includeNonTextElements`（boolean，默认 false）；排除集见 `DOC_OUTLINE_NON_TEXT_TAGS` |
| 4 | 排除为**静默**行为 | **不向大纲追加任何说明行**（早期版本的「已跳过 N 个非文本节点：…」汇总行被判定为内容污染，已移除） |
| 5 | 层级表示：**深度数字前缀**，不用缩进空格 | 见 §4.6.1 |

**非文本排除集**（`core/builtin-tools.ts` `DOC_OUTLINE_NON_TEXT_TAGS`，判据 = 内容以图形/二进制/代码为主、对页面结构信息量低却可能单标签贡献成百上千节点）：

- 图形：`svg`、`canvas`、`math`（典型：图标库、图表）
- 媒体 / 外部嵌入：`video`、`audio`、`picture`、`source`、`track`、`object`、`embed`、`iframe`、`frame`
- 代码 / 模板：`script`、`style`、`noscript`、`template`

**关键实现差异（相对 §4.2.1 原方案）**：大纲**在页面内生成**，不再经 outerHTML 传输后于扩展上下文加工。

- 注入函数 `collectDocumentInfoInPage` 直接从**活体 DOM** 遍历（`executeScript` 序列化执行 → 函数内非文本清单为**字面量副本**，不能引用模块级常量）；
- 只取 `tagName.toLowerCase()` + `id` + `class`，因此**天然不含脚本内容与事件属性等不安全内容**，无需 sanitize —— 也就省掉了 outerHTML 大字符串的跨上下文传输；
- 由此 **sanitize-html 只剩 `text`（正文纯文本）一处消费点**（`sanitizeDocumentText`），且其 `nonTextTags` 为**整表覆盖**语义，必须原样带上 sanitize-html 默认项（`script`/`style`/`textarea`/`option`/`xmp`），见常量 `SANITIZE_NON_TEXT_TAGS`。

**收敛**（避免大页面撑爆上下文）：

- `MAX_NODES = 1200`：超出后停止展开，末尾追加 `…(已达节点上限 1200 行，其余未展开)`（**唯一保留的说明行**，作为「输出不完整」的信号）；
- `MAX_SELECTOR_CHARS = 120`：单个 selector 超长截断加 `…`；
- 非文本子树排除**不产生任何输出**（静默）；截断说明**保留**；
- `outline` 最终再经 `truncateWithMarker(raw.outline, DOC_OUTLINE_MAX_CHARS=32_000)` 字符兜底。

**测试**（`builtin-tools.test.ts`）：用 jsdom 重建真实 DOM（`setDocumentHtml`）断言大纲根深度 0 / 每行 `<depth> <selector> [text]` / 零前导空白 / `div#app.container.main`、默认静默排除非文本子树（不含「已跳过」「非文本节点」字样，排除子树文本不泄漏）、`includeNonTextElements=true` 保留且不出现汇总、只保留结构不含 href/onclick/secret、节点上限截断说明、schema 三参数、`sanitizeDocumentText` 各分支。

### 4.6.1 大纲体积优化：缩进空格 → 深度前缀（2026-09-12 实测驱动）

**问题**（用户反馈）：验证后发现大纲中存在**大量重复的 `\n` + 空格字符**，属意外输出污染。

**量化证据**（真实 SPA 结构页面：120 行表格 + 30 项导航 + 20 个卡片区块）：

| 构成 | 字符数 | 占比 |
| ---- | ---- | ---- |
| **前导缩进空格** | 29,836 | **82.7%** |
| 实际内容（`tag#id.class`） | 5,129 | 14.2% |
| 换行符 | 1,201 | 3.3% |

两个根因：

1. **缩进是「可推导信息」却按字面存储**：`indent = 2 × depth`，平均 24.8 空格/行、最深 30 —— 82.7% 的字节只在表达「我在第几层」，而这个数是可以算出来的；
2. **96.8% 的行与其它行字符串完全重复**（1,202 行中 1,163 行重复；`td`×321、`div`×214、`span`×136…），78.4% 的行为无 id/class 的裸标签。

**方案对比**（原型实测，同一页面）：

| 方案 | 字符 | 行数 | 缩进占比 | 触发节点上限 |
| ---- | ---- | ---- | ---- | ---- |
| 现状（2 空格缩进） | 36,089 | 1,201 | 82.7% | ✅ |
| 缩进改单空格 | 21,171 (-41%) | 1,201 | 70.5% | ✅ |
| 缩进深度上限 8 级 | 25,293 (-30%) | 1,201 | 75.3% | ✅ |
| **深度数字前缀（采纳）** | **9,832 (-73%)** | 1,201 | **0%** | ❌ 否 |
| 同构兄弟折叠（备选，未采纳） | 4,730 (-87%) | 155 | 70.6% | ❌ |

**最终决策（用户确认）**：

- ✅ **采纳深度数字前缀**：每行固定 `<depth> <selector>`（如 `11 li.nav-item`），**零前导空白**，体积降至约 1/4；
- ❌ **不采纳「同构兄弟折叠」**（run-length，如 `tr ×120`）：虽体积更小（-87%）且可避免截断，但会改变「逐节点完整列出」的语义；本次保持每节点一行；
- ✅ **保留**节点上限截断说明行。

**产出形态**：

```
0 html
1 head
2 title 测量页
1 body
2 div#root
3 div.app
...
11 li.nav-item
12 a.nav-link 导航1
13 span
```

**副作用**：缩进消失后，`MAX_NODES=1200` 成为唯一边界（实测字符量约 10k，远低于 32k 字符上限）—— 后续若需覆盖更大页面，可单独评估是否上调节点数。

### 4.6.2 补齐文本节点：内联直接文本（2026-09-12）

**问题**（用户反馈）：「所有文本节点丢失」。根因【已验证】= `collectDocumentInfoInPage` 遍历用 `el.children`（**Element-only** 集合），文本节点（`nodeType === 3`）从不进入遍历 —— 这是 R5.1「元素结构大纲」决策的固有语义（当时对齐「只保留结构」），非本轮回归。影响：大纲只有骨架（`2 h1` / `12 a.nav-link`），页面语义（标题/段落/链接文字）全部缺失，必须再开 `includeText` 走 outerHTML + sanitize 重路径才能看到内容。

**决策（用户确认）**：**内联 + 默认包含**（不新增参数）—— 每行升级为 `深度 选择器 文本`；预算耗尽**追加一行说明**（区别于非文本排除的静默口径）。

**实现要点**：

- 取元素 `childNodes` 中 `nodeType === 3` 的**直接**文本节点拼接 —— 不含子元素文本（`<p>你好 <b>世界</b>！</p>` → `2 p 你好 ！` 与 `3 b 世界` 各归其位，无重复）；
- 选择器不含空格（id/class 名不允许空白字符），行内以空格分隔三段**无歧义**；
- 折叠连续空白、纯空白文本节点跳过（不产生文本后缀）；
- `script`/`style` 等排除子树的文本随子树一并消失，不混入大纲；
- **体量控制**：单节点截断 80 字符（+`…`）+ 全页文本总预算 8000 字符；预算耗尽后**结构行继续完整输出**（仅停止追加文本），末尾追加 `…(文本预算已用尽（全页文本上限 8000 字符），后续元素文本未收录)`；
- 预算常量为注入函数内**字面量**（executeScript 自包含约束）。

**测试**：直接文本不重复子元素文本 / 空白折叠与纯空白跳过 / 单节点 80 字符截断 / 预算耗尽说明行 + 结构行完整性（120 节点 × 100 字符 = 12000 > 8000 预算：前 100 节点带文本、后 20 节点仅结构）/ 排除子树文本不泄漏（`evil()`、`color:red` 不出现）。



---

## 5. 开放问题与决策结果

| # | 问题 | 决策（2026-09-11 用户确认） |
| ---- | ---- | ---- |
| Q1 | 「激活页签」与「选中页签」术语统一？ | **采纳建议**：统一为「选中页签」，默认 = 打开插件时的第一个活动页签 |
| Q2 | 全局选择是否保留多选能力？ | **多选全端生效**：agent 对话也支持多选中页签，合并全部选中页签的工具清单，调用按页签路由（见 §2.4） |
| Q3 | R4 的目标协议范围？ | **解读 A：协议适配器**。设置页增加协议类型，OpenAI 兼容（现状）+ 新增具体适配器 |
| Q4 | R5.1 数组元素语义？ | **每选中页签一个元素**：与全局多选联动，选中 N 个页签返回 N 个文档信息对象 |
| Q5 | 侧栏关闭再打开，选择是否重置？ | **重置（2026-09-11 用户确认）**：侧栏关闭再打开时重新执行选择当时的激活页签，不沿用上次选择 |
| Q6 | 内置工具暴露范围？ | **方案 C：双端统一**。`core/builtin-tools.ts` 单一注册表，agent / tools 调试 / relay 三处合并生效 |

### 5.1 「多选全端生效」的关键设计影响（Q2 决策展开）

【已验证】panel-client 现状是**单 Port 单页签**模型（一个 Port、一个 connected 布尔位、一个 pending 表）。多选全端生效意味着它要升级为**多连接编排**：

- **多 Port 并存**：每个选中页签一条 `tabs.connect` Port；`listTools` 合并各页签结果，`callTool` 按工具名路由到对应页签的 Port。
- **同名工具去歧义**【已验证：relay 端已有「同名工具跨 tab 去歧义」语义（tab-source-manager.ts L2-3 模块注释），但仅是 source 模型描述，无统一命名规则】。侧栏 agent 侧需定义规则，两个候选：
  - 暴露名加前缀 `tab<id>__<toolName>`（对 LLM 无歧义，需在 description 里注明原始名）；
  - 同名冲突时仅暴露首个命中页签（简单，但静默丢失其他页签工具）。
  → propose 阶段二选一，倾向前缀方案。
- **在线状态语义**：`connected` 从布尔位变为逐页签状态聚合（全部离线才显示离线，或展示 n/m 已连）。
- **断线重连**：退避重连按各页签独立进行，重连目标 = 各自 tabId（不重查活动页签）。
- **R5.1 联动**：`chrome_extension_get_document_info` 在多选下对每个选中页签各执行一次注入收集，按下标/页签顺序返回数组 —— 单选时长度 1，天然满足「每选中页签一个元素」。
- 【推断】工具清单变化推送（toolsChanged）需按 Port 来源归并去抖，避免多 Port 同时推送导致 agent 每轮 listTools 抖动。

---

## 6. 影响面汇总

- **改（2026-09-12 对齐后更新）**：§2.2 表 + `llm-client.ts`/`SettingsPage`（R4：openai-compat + anthropic 双适配器）+ 新增 `core/builtin-tools.ts`（R5）。
- **改（R5.2 追加）**：`main-extension/side-panel/panel-client.ts`（新增 `attachBuiltinTools`）+ `App.ts`（改用合成客户端，移除 runTurn 内的清单合并与 `executeTool` 拦截）+ `debugger-core.ts`（`describeInputSchema` / `buildArgsTemplate`）+ `pages/DebugPage.ts`（参数说明面板 + 填入参数模板按钮）+ `side-panel.html`（参数面板样式）。
- **改（R5.3 + R5.1 修订）**：`core/builtin-tools.ts` —— 结果包装为 MCP CallToolResult（R5.3）；大纲改由页面内活体 DOM 生成、三参数 schema（`includeOutline`/`includeText`/`includeNonTextElements`）、**层级用深度前缀（`<depth> <selector>`，无缩进空格）**、**内联直接文本节点（默认包含；单节点 80 字符 + 全页文本预算 8000，耗尽追加说明行）**、非文本子树静默排除（不再追加汇总行）、删除 HTML 白名单与 `sanitizeDocumentContent`、`sanitizeDocumentText` 保留为唯一 sanitize 消费点；`builtin-tools.test.ts` 同步重写。
- **不改 manifest**：R4.1 已决策移除（§3.1，安全优先不支持通用 http），`shell/manifest.json` 权限面保持现状。
- **注释修正**：`llm-client.ts` L2「扩展页面上下文无 CORS 限制」改为条件化表述（host 权限覆盖的主机才豁免 CORS），纯注释改动。
- **不改**：`core/content-script.ts`、`page-tools-bridge` 协议、relay 服务端（webmcp-extension-relay）。
- **测试**：`tab-source-manager.test.ts`、`panel-client.test.ts`、`agent-loop.test.ts`、`llm-client.test.ts`（新增 anthropic adapter 与协议分发用例）新增/改写；新增 `builtin-tools.test.ts`。
- 验证闸门：`pnpm typecheck` / `pnpm lint` / `pnpm test`（服务管理约束：build/dev 由用户手动执行）。
