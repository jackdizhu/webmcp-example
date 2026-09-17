# 待改造文件清单：webmcp-agent-chat-core

> 审查依据：`rules/coding-style.md` §2.1（通用代码质量规范）。
> 审查日期：2026-09-16（基于 dev-base 工作区快照，行号为当日快照行号）。
> 范围：`packages/webmcp-agent-chat-core/src` 全部 `.ts` 文件（不含 node_modules/dist）。

## 使用说明

- 本包定位为**零 UI、零浏览器 API** 的纯逻辑共享库，无 Vue 组件，**不涉及 §3 UI/TSX 迁移**，本清单只覆盖 §2.1 复杂度与质量问题。
- 硬阈值：单文件 ≤ 800 行；函数体 ≤ 50 行；圈复杂度 ≤ 10；嵌套 ≤ 3 层；参数 ≤ 3；默认值回退用 `??` 不用 `||`；魔法数字/字符串提取具名常量；禁空 catch / 吞异常；DRY（Rule of Three）。

## 一、复杂度问题清单（§2.1）

### 🟡 中严重度

| 文件 | 行数 | 问题（行号证据） |
|---|---|---|
| src/llm-client.ts | 387 | `anthropic` 适配器 complete:270–367（约 98 行）、`openai` 适配器 complete:104–175（约 72 行）超 50 行阈值；两适配器 fetch/错误处理/日志段 126–155 与 300–332 几乎同构（DRY，可提取公共请求层）；:106 `'/chat/completions'` 默认路径字面量未提常量；:272 报错文案与 API_PATH_EMPTY_HINT 不对称硬编码 |
| src/a2a-tool-source.ts | 345 | `callTool` 234–337（约 104 行）：入参校验 + 串行守卫 + 委派 + 轮询 + 文本化 + 错误包装混合，单一职责违反；:82 `card.description \|\| '（无描述）'` 应为 `??`；:211–213 validate 失败静默入 failures，无独立日志（吞异常） |
| src/a2a-client.ts | 270 | fetchAgentCard 网络层 203–221 与 rpcCall:154–177 重复（DRY）；fetchAgentCard try 内嵌 try（嵌套 4 层） |
| src/chat-controller.ts | 172 | `runTurn` 100–166（约 67 行）超长：编排 + 错误分型混合（轻微） |

### 🟢 低严重度

| 文件 | 行数 | 问题 |
|---|---|---|
| src/agent-loop.ts | 204 | `runAgentLoop` 137–203 为 4 个位置参数（> 3，可聚合对象参数）；整体干净 |
| src/agent-profile.ts | 357 | `validateAgentProfilesState` 221–268 校验链冗长但平坦（无实质违规）；行数膨胀主要来自内置档案长文案 |
| src/skill-loader.ts | 182 | :161–163 `catch { override = null }` 吞异常（有注释说明，低） |
| src/logger-core.ts | 115 | `createLogEntry` 61–68 共 6 参数（> 3，可聚合） |

### ✅ 无违规

| 文件 | 行数 | 说明 |
|---|---|---|
| src/index.ts | 121 | 纯导出聚合 |
| src/a2a-config.ts | 106 | — |
| src/a2a-types.ts | 291 | 纯类型定义 |
| 各 *.test.ts | 75–380 | 仅行数关注，无死代码 |

## 二、整体面结论

- **无单文件超 800 行**（最大 llm-client.ts 387 行）；无 `any` 违规；无注释死代码。
- 债务模式与 chrome-extension 侧一致：**超长函数 + 双实现同构重复（DRY）+ 个别 `\|\|` 回退与吞异常**。
- 优先处理项：llm-client.ts 双适配器提取公共请求/错误处理层；a2a-tool-source.ts `callTool` 按职责拆分（校验 / 守卫 / 委派轮询 / 文本化）；a2a-client.ts 网络层去重。
