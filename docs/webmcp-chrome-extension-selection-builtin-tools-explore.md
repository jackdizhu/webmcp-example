# webmcp-chrome-extension 需求探索：页签连接全局化 + LLM HTTP 协议 + 内置 Tools

> 状态：**已实施（apply-change 完成，2026-09-12）**。验证：typecheck / lint / test（163/163）全绿；
> dist 经 watch 构建已含全部新能力（SW 构建标记 `global-tab-selection + builtin-tools (2026-09-12)`）。
> 实现对齐说明：`reset-selection` 已作为独立协议消息落地（§3.1 决策记录保留）；
> 同名工具去歧义采用 `tab<id>__<toolName>` 前缀方案（全部冲突实例统一加前缀）。
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
| R5.1 | `chrome_extension_get_document_info`：获取当前激活页签文档信息，**以数组返回，每个元素一个文档信息对象** | 数组语义需澄清（见 §5.3） |

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

入参（`html` / `text` 为**可选开关，默认 false 不携带**，防止无效大字段污染上下文，2026-09-11 需求补充）：

```jsonc
// inputSchema
{
  "type": "object",
  "properties": {
    "includeHtml": { "type": "boolean", "description": "返回经 sanitize-html 清洗的 HTML 内容，默认 false" },
    "includeText": { "type": "boolean", "description": "返回清洗+空白压缩后的正文纯文本，默认 false" }
  }
}
```

返回（单元素为「文档信息对象」；`html` / `text` 仅在对应入参为 true 时存在）：

```jsonc
{
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
  "html": "<!DOCTYPE html><html>…经 sanitize-html 清洗后的 HTML…",   // 仅 includeHtml=true
  "text": "…经 sanitize-html 清洗 + 空白压缩后的正文纯文本…"          // 仅 includeText=true
}
```

### 4.2.1 HTML 内容清洗与文本压缩（2026-09-11 需求补充）

文档信息对象可按调用参数**选带当前 HTML 文档内容**（`includeHtml` / `includeText`，默认 false），处理管线：原始 `document.documentElement.outerHTML` → **sanitize-html 清洗** → 按需产出：

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
- **不改 manifest**：R4.1 已决策移除（§3.1，安全优先不支持通用 http），`shell/manifest.json` 权限面保持现状。
- **注释修正**：`llm-client.ts` L2「扩展页面上下文无 CORS 限制」改为条件化表述（host 权限覆盖的主机才豁免 CORS），纯注释改动。
- **不改**：`core/content-script.ts`、`page-tools-bridge` 协议、relay 服务端（webmcp-extension-relay）。
- **测试**：`tab-source-manager.test.ts`、`panel-client.test.ts`、`agent-loop.test.ts`、`llm-client.test.ts`（新增 anthropic adapter 与协议分发用例）新增/改写；新增 `builtin-tools.test.ts`。
- 验证闸门：`pnpm typecheck` / `pnpm lint` / `pnpm test`（服务管理约束：build/dev 由用户手动执行）。
