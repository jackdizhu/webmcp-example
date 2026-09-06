# 功能调整设计：systemPrompt 可配置 + 历史对话按轮裁剪

> **状态：设计稿（待确认后实施）**。目标包：`packages/webmcp-chrome-extension`（侧边栏 agent）。
> 所有「已验证」结论均基于当前源码逐行核对；「推断」项已单独标注。

---

## 1. 现状分析（已验证调用点）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 默认提示词 | `main-extension/side-panel/agent-loop.ts` L83-85 `DEFAULT_SYSTEM_PROMPT` | 硬编码字符串 |
| 提示词注入 | `agent-loop.ts` L120 `options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT` | 用 `??` 回退，**空字符串不会回退**，仅 undefined/null 生效 |
| 提示词传入 | `App.ts` `runTurn` 调用 `runAgentLoop` | **未传** `systemPrompt`，默认值恒定生效 |
| 历史上下文 | `App.ts` L72 `let history: ChatMessage[] = []` | 每轮 `history = result.transcript` 全量替换，**跨轮无限增长，无裁剪** |
| 历史 content | `agent-loop.ts` transcript 含 tool 消息（工具结果完整 JSON 序列化回填） | 工具大结果是 token 消耗主力 |
| 设置结构 | `panel-client.ts` `PanelSettings` / `DEFAULT_SETTINGS` / `SETTINGS_KEYS` | 仅 apiKey / baseUrl / model / debugMode / consoleOutput |
| 设置读写 | `panel-client.ts` `loadSettings` / `saveSettings` | 键名手工映射到 chrome.storage.local |
| 设置表单 | `components/SettingsPanel.ts` | `textInput`（input）+ `checkbox` 两个 helper，**无 textarea / number** |
| 表单同步 | `App.ts` `persistSettings` / `toggleDebugMode` / `onMounted` | 三处手写字段列表（已有重复，新增字段需同步三处） |

**协议约束（已验证，决定裁剪策略）**：history 中 assistant 消息可能携带 `toolCalls`，其后必须紧跟对应 `toolCallId` 的 tool 消息（OpenAI 兼容协议）。**按条数裁剪会切出孤儿 tool 消息导致 API 报错**，因此必须按「轮」裁剪且切点落在 user 消息。

---

## 2. 功能 1：systemPrompt 设置界面可配置（textarea）

### 2.1 数据模型（panel-client.ts）

```ts
export interface PanelSettings {
  // ...现有字段
  /** agent 系统提示词；空串表示使用内置默认。 */
  systemPrompt: string;
}

import { DEFAULT_SYSTEM_PROMPT } from './agent-loop';   // 单一事实来源，避免双处硬编码

export const DEFAULT_SETTINGS: PanelSettings = {
  // ...
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

const SETTINGS_KEYS = [
  'llmApiKey', 'llmBaseUrl', 'llmModel', 'debugMode', 'consoleOutput', 'llmSystemPrompt',
] as const;
```

- `loadSettings`：`typeof stored['llmSystemPrompt'] === 'string' ? stored[...] : DEFAULT_SETTINGS.systemPrompt`
- `saveSettings`：新增 `llmSystemPrompt: settings.systemPrompt`
- 无循环依赖风险（已验证：agent-loop 为纯逻辑模块，不反向依赖 panel-client）

### 2.2 表单（SettingsPanel.ts）

新增 `textareaInput` helper（与 `textInput` 同构，`h('textarea', { rows: 4, ... })`，class `settings-textarea`，样式表补一条 `width:100%; resize:vertical; font: inherit`）：

```
系统提示词（textarea，rows=4）        [恢复默认]（可选 P1）
提示：留空则使用内置的页面工具验证助手提示词。
```

### 2.3 注入（App.ts `runTurn`）

```ts
const result = await runAgentLoop(
  [...boundedHistory, { role: 'user' as const, content: userText }],
  tools,
  { llm, executeTool: ... },
  {
    systemPrompt: settings.systemPrompt.trim() || undefined,   // 空串归一化为 undefined
    onEvent: ..., signal,
  }
);
```

⚠️ **关键细节（已验证）**：agent-loop 回退用的是 `??`，`''` 不会触发默认值，所以**必须在 App 层把空串归一化为 `undefined`**（如上）。`trim()` 防止纯空白提示词被当作有效配置。

### 2.4 字段同步收敛（建议顺带做）

`persistSettings` / `toggleDebugMode` / `onMounted` 三处手写字段列表改为一个本地辅助函数 `toPanelSettings(settings)`，消除既有重复（新增字段正是踩这个重复点的场景）。

---

## 3. 功能 2：历史对话按轮裁剪（默认 5）

### 3.1 裁剪语义

- **单位：轮（turn）**。一轮 = 1 条 user 消息 + 其后全部 assistant/tool 消息（直到下一条 user）。
- 保留**最近 N 轮**，默认 `N = 5`；`N = 0` 表示不裁剪（关闭功能）。
- **切点必为 user 消息** → 天然保证 assistant tool_calls 与 tool 消息配对完整（满足协议，见 §1 末）。
- 工具结果随所属轮一并裁掉——这正是主要收益（工具返回的完整 JSON 是最大的 token 开销）。

### 3.2 纯函数（agent-loop.ts，与循环逻辑同文件便于测试）

```ts
/**
 * 按轮裁剪历史：保留最近 maxTurns 轮（以 user 消息为轮首）。
 * maxTurns <= 0 时原样返回（不裁剪）。切点必为 user 消息，
 * 保证 assistant tool_calls 与 tool 消息的配对完整。
 */
export function trimHistory(
  history: readonly ChatMessage[],
  maxTurns: number
): ChatMessage[] {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) return [...history];
  const turnStarts: number[] = [];
  history.forEach((m, i) => { if (m.role === 'user') turnStarts.push(i); });
  if (turnStarts.length <= maxTurns) return [...history];
  return history.slice(turnStarts[turnStarts.length - maxTurns]);
}
```

> 约束（已验证）：`runTurn` 每轮恰好 push 1 条 user 消息且位于轮首，`runAgentLoop` 约定 history 以 user 结尾——按 user 索引切轮与现有数据形态完全吻合。**推断项**：若未来出现非 runTurn 来源的历史（如多 user 连发），轮首假设需重新审视。

### 3.3 接入点（App.ts `runTurn`）

```ts
// 裁剪发生在「传入之前」：result.transcript 自然继承收敛后的历史，逐轮有界
const boundedHistory = trimHistory(history, settings.maxHistoryTurns);
const result = await runAgentLoop(
  [...boundedHistory, { role: 'user' as const, content: userText }],
  ...
);
history = result.transcript;
```

> 为什么放在 App 层而非 runAgentLoop 内部：agent-loop 的 `transcript` 与传入 history 同构（含完整轮次语义），在入口裁剪即可让「发送给 LLM 的消息」与「下一轮 history」同时收敛，单点生效、无需改 transcript 结构。

### 3.4 设置项（panel-client.ts + SettingsPanel.ts）

```ts
/** 每轮发送给 LLM 的历史轮数上限；0 = 不裁剪。默认 5。 */
maxHistoryTurns: number;
```

- storage key：`agentMaxHistoryTurns`
- `loadSettings` 校验：`typeof === 'number' && Number.isInteger && >= 0`，否则回退默认 5
- 表单：数字输入 `h('input', { type: 'number', min: 0, step: 1 })` + hint 文案：
  「每轮发送给 LLM 的历史对话轮数上限（默认 5，0 = 不裁剪）。裁剪以轮为单位，工具执行结果随所属轮一并裁剪，可显著降低 token 消耗。」

### 3.5 UI 消息与历史的关系（边界说明）

侧栏 UI 的 `messages`（ChatPage 展示）与发给 LLM 的 `history` 是两条独立数据（已验证：UiMessage 仅展示用）。本设计**只裁剪 LLM 上下文，不裁剪 UI 展示**——用户仍能看到全部对话，只是模型「记不得」被裁掉的部分。

---

## 4. 改动清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `agent-loop.ts` | 新增导出 `trimHistory` 纯函数 | 逻辑 |
| `agent-loop.test.ts` | trimHistory 单测：多轮裁剪 / 轮数不足原样 / 0 不裁剪 / 切点为 user / tool 配对完整 / 非法入参 | 测试 |
| `panel-client.ts` | `PanelSettings` +2 字段、`DEFAULT_SETTINGS`、`SETTINGS_KEYS`、load/save 扩展 | 逻辑 |
| `panel-client.test.ts` | 新字段读写与回退（缺失 / 类型错误）用例 | 测试 |
| `components/SettingsPanel.ts` | `textareaInput` + 数字输入 helper，两个新表单项 | UI |
| `styles.css`（侧栏样式） | `.settings-textarea` 样式 | UI |
| `App.ts` | settings reactive 初始化 2 字段；runTurn 注入 systemPrompt + trimHistory；三处字段列表收敛为辅助函数 | 编排 |
| `pages/SettingsPage.ts`、`components/types.ts` | **无需改动**（props 透传，已验证） | — |

## 5. 明确不做（边界）

- 不持久化对话历史（侧栏关闭即丢，维持现状）
- 不做 token 估算型裁剪（按轮数是确定性简化，先解决失控增长）
- 不改 agent-loop 的 transcript 结构与 system 临时拼接语义

## 6. 验证闸门（手动执行，遵守服务管理约束）

```
pnpm typecheck && pnpm lint && pnpm test
```

## 7. 实施顺序（确认后执行）

1. panel-client.ts：字段 + 读写 + 测试
2. agent-loop.ts：trimHistory + 测试
3. SettingsPanel.ts + 样式：textarea / number 表单
4. App.ts：接线（含三处字段列表收敛）
5. 跑验证闸门，回归一轮真实对话（改提示词 / 观察第 6 轮起请求消息数不再增长）
