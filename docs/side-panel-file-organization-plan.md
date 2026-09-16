# side-panel 目录分类规整方案

> 2026-09-16 | 状态：**已落地**（文件由用户手动迁移，22 处失效 import 由 AI 修复，三闸门验证全绿，见文末第 9 节）

## 1. 背景

`main-extension/side-panel/` 根目录当前散落 **17 个 ts 文件**（9 源文件 + 8 测试），与已有 `pages/`、`components/`、`i18n/`、`style/` 四个目录并存，根目录臃肿。

## 2. 依赖关系分析结论（已验证）

| 检查项 | 结论 |
|---|---|
| side-panel 之外的引用 | **零引用**（全 packages 范围搜索，无任何外部 import 指向这些文件） |
| vite.config.ts 硬编码路径 | 仅 3 处：`side-panel/index.ts`（entry）、`side-panel.html`（copy）、`side-panel/style`（copy）→ 均不动，**构建配置零改动** |
| manifest.json | 仅引用 `side-panel.html` → 不动 |
| tsconfig.check.json | 包级整体 include，无逐文件列举 → 无需改 |
| e2e-extension | 独立产物，entry 同为 `side-panel/index.ts` → 不受影响 |

结论：**影响面完全收敛在 side-panel 内部**，移动后只需修改 side-panel 内的相对 import 路径，纯机械替换、无逻辑改动。

## 3. 方案 A：业务域分组（推荐）

与现有惯例对齐（`components/a2a`、`style/a2a.css`、`pages/A2aPage.ts` 均按领域组织），领域内聚最强：

```
side-panel/
├─ index.ts              # 留根：vite entry
├─ App.ts                # 留根：根组件/纯编排层
├─ side-panel.html       # 留根：vite copy + manifest 引用
├─ sfc-shim.d.ts         # 留根：全局类型声明（.d.ts）
├─ i18n/  pages/  components/  style/     # 已有目录，不动
│
├─ a2a/                  # A2A 域：配置存储 + 宿主 + 智能体档案
│  ├─ a2a-config-store.ts        (+ .test.ts)
│  ├─ a2a-host.ts
│  └─ agent-profile-store.ts     (+ .test.ts)
│
├─ relay/                # Relay 状态域：订阅客户端 + store
│  ├─ relay-status-client.ts     (+ .test.ts)
│  └─ relay-status-store.ts      (+ .test.ts)
│
├─ logger/               # 日志子系统：门面 + 核心 + DB + 追踪上下文
│  ├─ logger.ts                  # 门面
│  ├─ logger-core.ts             (+ .test.ts)
│  ├─ logger-db.ts
│  └─ trace-context.ts           (+ .test.ts)  # logger 门面自动附加 traceId，同子系统
│
└─ runtime/              # agent 运行时支撑（命名备选：agent/）
   ├─ panel-client.ts             (+ .test.ts)  # 页面工具客户端（工具合成链）
   ├─ skill-assets.ts             (+ .test.ts)  # 内置技能资产读取
   └─ debugger-core.ts            (+ .test.ts)  # 调试 Tab 纯逻辑（DebugPage 底层）
```

分组依据：
- **a2a/**：三个文件同属 A2A 解耦改造（config-store 是全局单份配置、host 是平台接线、agent-profile 是智能体档案存储），且 `skill-assets → agent-profile-store` 有依赖关系。
- **relay/**：client 与 store 是同一状态链的上下游（store 订阅 client 三路推送）。
- **logger/**：四个文件构成自包含闭环（db→core、门面→core/db、trace-context 被门面附加），对外只暴露 `logger.ts` 一个入口。
- **runtime/**：panel-client / skill-assets / debugger-core 同为 agent 能力面的纯逻辑支撑，均与 UI 解耦、可单测。

## 4. 方案 B：技术职责分层（备选）

按 store / service / lib 技术角色切分：

```
├─ stores/       # 持久化状态：a2a-config-store、agent-profile-store、relay-status-store（+tests）
├─ services/     # 运行时客户端/宿主：panel-client、a2a-host、relay-status-client、skill-assets（+tests）
├─ lib/          # 纯逻辑：debugger-core、trace-context（+tests）
└─ logger/       # logger、logger-core、logger-db（+tests）
```

对比：方案 B 目录语义通用，但 **a2a 相关文件被拆到 stores/ 与 services/ 两处**，领域内聚弱于方案 A；且与 components/、style/ 已有的按域惯例不一致。**推荐方案 A**。

## 5. 迁移清单（方案 A，逐文件）

| # | 源（side-panel/） | 目标 |
|---|---|---|
| 1 | `a2a-config-store.ts` + `.test.ts` | `a2a/` |
| 2 | `a2a-host.ts` | `a2a/` |
| 3 | `agent-profile-store.ts` + `.test.ts` | `a2a/` |
| 4 | `relay-status-client.ts` + `.test.ts` | `relay/` |
| 5 | `relay-status-store.ts` + `.test.ts` | `relay/` |
| 6 | `logger.ts` | `logger/` |
| 7 | `logger-core.ts` + `.test.ts` | `logger/` |
| 8 | `logger-db.ts` | `logger/` |
| 9 | `trace-context.ts` + `.test.ts` | `logger/` |
| 10 | `panel-client.ts` + `.test.ts` | `runtime/` |
| 11 | `skill-assets.ts` + `.test.ts` | `runtime/` |
| 12 | `debugger-core.ts` + `.test.ts` | `runtime/` |

**留根不动**（4 个）：`index.ts`、`App.ts`、`side-panel.html`、`sfc-shim.d.ts`。
已有 4 目录不动：`i18n/`、`pages/`、`components/`、`style/`。

## 6. import 修改清单（约 28 处）

### 6.1 非移动文件（引用方，10 处）

| 文件 | 需修改的 import |
|---|---|
| `App.ts` | a2a-config-store、a2a-host、agent-profile-store、logger、trace-context、panel-client、relay-status-client、relay-status-store、skill-assets、debugger-core（共 10 条） |
| `pages/DataSourcePage.ts` | relay-status-client（1 条） |
| `pages/DebugPage.ts` | logger、panel-client、debugger-core（3 条） |
| `pages/SettingsPage.ts` | logger、panel-client（2 条） |
| `components/datasource/ConnectionActions.ts` | logger、relay-status-client（2 条） |
| `components/datasource/DataSourcePicker.ts` | logger、relay-status-client（2 条） |
| `components/settings/SettingsForm.ts` | panel-client（1 条） |
| `components/settings/SettingsSummary.ts` | panel-client（1 条） |

路径规则：引用方在 `pages/`、`components/xxx/` 下，`./xxx` → `../../a2a/xxx`、`../../relay/xxx`、`../../logger/xxx`、`../../runtime/xxx`。

### 6.2 移动文件之间互引（6 处）

| 文件（移动后位置） | 修改 |
|---|---|
| `logger/logger-db.ts` | `./logger-core` 不变 |
| `logger/logger.ts` | `./logger-core`、`./logger-db`、`./trace-context` 不变 |
| `relay/relay-status-store.ts` | `./relay-status-client` 不变 |
| `a2a/`（无互引） | a2a-host、a2a-config-store 无互引 |
| `runtime/skill-assets.ts` | `./agent-profile-store` → `../a2a/agent-profile-store` |
| `runtime/panel-client.ts`、`runtime/debugger-core.ts` | 无域内互引（引 i18n、core 包别名等，检查相对路径深度） |

> 注意：移动后文件若引用 `pages/`、`components/`、`i18n/`，相对深度从 `./` 变 `../`，逐条核对即可。

### 6.3 测试文件（8 个）

跟随源文件同目录移动，内部 `./xxx` 引用基本不变；若测试还引了其他根目录模块（如 `panel-client.test.ts` 引 panel-client x2），按新相对深度调整。

## 7. 验证步骤（移动完成后）

1. 三闸门只读校验（AI 可代跑）：
   - `node <root>/node_modules/.pnpm/vitest@5.0.0_*/node_modules/vitest/vitest.mjs run --root packages/webmcp-chrome-extension`
   - `node <root>/node_modules/.pnpm/typescript@5.9.3_*/node_modules/typescript/bin/tsc -p packages/webmcp-chrome-extension/tsconfig.check.json --noEmit`（如有包级 check 配置）
   - eslint（在包目录下执行）
2. 用户手动：`pnpm build`（vite.config 零改动预期下产物应与改动前结构一致）
3. Chrome reload 扩展，回归：侧栏 6 页签、agent 对话（logger traceId）、数据源状态订阅、A2A 配置保存、调试页签。

## 8. 风险与备注

- **App.ts 是改动重灾区**（10 条 import），建议最后改、改完全文 Grep 复核一遍旧路径（`./logger'`、`./panel-client'` 等）应零残留。
- 全仓 Grep 旧路径 `from './logger'`、`from './a2a-host'` 等确认无遗漏（含 .vue 文件）。
- `docs/theme-preview/` 沙盘镜像不受影响（镜像的是 HTML/CSS，不引 ts）。
- 本次为纯路径迁移，不涉及命名变更（文件名保持原名），避免与「页面工具 tab 前缀」「a2a 工具名前缀」等运行时语义混淆。

## 9. 落地记录（2026-09-16）

用户按方案 A 完成手动迁移（四个目录各附 README.md），AI 检查发现 **22 处失效相对 import** 并全部修复：

| 类别 | 文件与修复 |
|---|---|
| App.ts（6 处） | `./agent-profile-store`→`./a2a/agent-profile-store`；`./skill-assets`→`./runtime/skill-assets`；`./debugger-core`→`./runtime/debugger-core`；`./logger`→`./logger/logger`；`./trace-context`→`./logger/trace-context`；`./panel-client`→`./runtime/panel-client` |
| logger 目录导入（6 处） | `logger/` 无 index.ts，目录导入必须指向具体文件：ConnectionActions、DataSourcePicker、DebugPage、SettingsPage、relay-status-store 的 `../logger`→`../logger/logger` |
| panel-client 引用（4 处） | SettingsForm、SettingsSummary、DebugPage、SettingsPage → `runtime/panel-client` |
| core 三层深度（4 处） | `core/` 在包根，runtime/ 下需三层：panel-client.ts 与 panel-client.test.ts 的 `../../core/...`→`../../../core/...` |
| 跨域引用（2 处） | skill-assets.ts、skill-assets.test.ts 的 `./agent-profile-store`→`../a2a/agent-profile-store` |

配置零改动确认：vitest include `main-extension/**/*.test.ts`、tsconfig include `main-extension/**/*` 均为通配符，自动覆盖新目录。

**验证结果（三闸门全绿）**：
- vitest：15 个测试文件 / 182 个测试全部通过
- tsc（tsconfig.check.json --noEmit）：PASS
- eslint（side-panel 目录）：PASS
