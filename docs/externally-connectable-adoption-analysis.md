# externally_connectable 方案采用分析：改动清单与风险清单

> 状态：决策分析稿（2026-09-19）
> 关联：`docs/webmcp-chrome-extension-tab-invoked-agent-task-explore.md`（C5 已实施）、`docs/extension-tab-communication-channels.md`（通道对比）
> 结论速览：**技术上可行，但不建议作为 C5 主通道**；若采用，定位应为「固定域名并存加速路径」。三个硬约束——matches 禁止通配 host（官方规则）、sender 无 tab（Q6 页签解析失效）、无主动下行通道——决定了它无法覆盖 C5 的「任意 origin 页面 + tool 直调」场景。

---

## 1. 事实核验（本分析的前提）

| # | 事实 | 来源 | 置信 |
|---|---|---|---|
| F1 | externally_connectable.matches 的 URL pattern **必须包含至少二级域名**；裸通配 host（`*`、`*.com`、`*.co.uk` 等）与 `<all_urls>` 均**不合法** | Chrome 官方 messaging 文档（"The URL pattern must contain at least a second-level domain … are prohibited"） | 官方文档 ✅ |
| F2 | match pattern 默认**匹配所有端口**（除非显式指定）；`http://localhost/*` 命中任意 localhost 端口 | 官方 match_patterns 文档（"Match patterns match all ports unless an explicit port is specified"） | 官方文档 ✅ |
| F3 | 网页发起的 external 消息/连接，sender 含 `url`/`origin`（以及可能的 `id`），**无 `sender.tab`**——tab 字段仅当连接从 tab 上下文（content script 等）发起时存在 | 官方 MessageSender 字段语义 + 社区佐证（"sender will contain either an extension ID or the URL of the page"） | 高置信推断 ⚠️ |
| F4 | **扩展不能主动向网页发消息**（"It is not possible to send a message from an extension to a web page"）；下行仅限页面已建立的 Port 上回发，或 sendMessage 的 response 回调 | Chrome 官方 messaging 文档原文 | 官方文档 ✅ |
| F5 | externally_connectable 消息存在官方节流配额 | MV2 时代文档/社区共识，**MV3 文档未见明确声明** | 待实测 ⚠️ |
| F6 | 页面侧需感知扩展 id（硬编码调用 `chrome.runtime.sendMessage(extensionId, …)`） | 官方文档示例 | 官方文档 ✅ |

> 事实修正：上一轮对比文档曾写「动态 origin 需放通 all_urls」——按 F1 该写法本身不合法，已同步修正（见 §6）。

## 2. 与现链路的架构差异

```text
现状（4 跳）                          externally_connectable（2 跳）
SDK ─postMessage→ CS ─Port→ SW ─Port→ 宿主     SDK ─chrome.runtime.connect→ SW ─Port→ 宿主
      （公开信道）  （可信注入）                     （浏览器级准入，sender.origin 背书）
```

| 维度 | 现链路（postMessage + Port） | externally_connectable |
|---|---|---|
| 上行 | 任意页面（CS 全量注入） | 仅 manifest matches 内页面 |
| 准入控制 | 运行时 `tabInvokeAllowlist`（storage，用户可自助改） | manifest 静态（改一次发一次版）+ 运行时 allowlist 可叠加 |
| sender 可信度 | `Port.sender.tab.id/origin`（SW 注入） | `sender.origin/url` 浏览器背书；**无 tab**（F3） |
| 下行 | SW→CS 同 Port 反向 + CS→SDK postMessage（随时可推送） | 仅已建 Port 回发 / response 回调（F4） |
| 信道私密性 | window 事件流公开（页面可窃听/伪造） | 页面其他脚本不可见 `chrome.runtime` 消息 |
| SW 休眠 | 心跳保活（pending>0 才发） | 页面 connect 事件可唤醒 SW |
| 调用方 tabId | 可信可得（Q6 第 2 步可用） | **不可得**（F3） |

## 3. 改动清单（模块级 old → new）

| # | 模块 / 文件 | 改动内容 | 量级 |
|---|---|---|---|
| M1 | `shell/manifest.json` | 新增 `"externally_connectable": { "matches": ["http://localhost:5173/*"] }`（显式端口收窄暴露面，见 R3）；无需新权限（tabs/storage 已在 L12） | 小 |
| M2 | `shell/agent-task-sdk.ts` | transport 分流：探测 `chrome.runtime?.connect`（matches 内页面被浏览器注入该 API）→ 优先 `connect(EXTENSION_ID, { name })` 走 external Port；不可用/被拒则降级现有 postMessage 链路。错误码映射 `chrome.runtime.lastError` → AgentTaskErrorCode；扩展 id 常量化（F6，id 已由 manifest key 固定） | 中 |
| M3 | `core/agent-task-tab-bridge.ts` | 不删除：external 分支命中时旁路（非 matches 页面、降级路径仍依赖）；心跳在 external 模式下改走 Port 内消息 | 小-中 |
| M4 | `core/agent-task-router.ts` | 新增 `onConnectExternal` / `onMessageExternal` 监听并与 `onConnect` 并存分流（现 :141-143 的 `port.sender?.tab?.id` 在 external 分支不存在）；sender 映射改为 `{ tabId: port.sender?.tab?.id ?? null, origin: port.sender?.origin ?? new URL(port.sender?.url ?? '').origin }`；external 分支跳过 tab-sender 断连逻辑 | 中 |
| M5 | `core/agent-task-protocol.ts` | `AgentTaskRoutedCreateMessage.sender.tabId: number` → `number \| null`（协议破坏性变更，SDK/bridge/router/host 全链路类型联动 + 守卫 `isRoutedCreate` 放宽） | 中 |
| M6 | `side-panel/runtime/agent-task-host.ts` | `resolveToolName`（:122-145）Q6 第 2 步 `tab<id>__` 前缀解析依赖 callerTabId——tabId=null 时退化策略（见 R2）；`acceptTask`（:417-509）sender 构造与会话 origin 落库适配（origin 仍可得） | 中 |
| M7 | SettingsPage 白名单 UI + i18n | 文案更新：manifest matches 是第一层准入，运行时白名单变为第二层开关（或对 external 通道直接复用同一 allowlist 键） | 小 |
| M8 | html-app `agent-task-test.ts` | 功能不变（SDK 内部分流）；可选加「当前通道」指示徽标 | 小 |
| M9 | 单测 | router（onConnectExternal 分流 + external sender 形态）、protocol（tabId 可空守卫）、host（tabId=null 的 resolveToolName 退化矩阵）改造；现 StubHostPort 模式可复用 | 中 |
| M10 | 文档 | explore 文档 §4 增补 external 备选形态；对比文档 §3.1 修正（见 §6） | 小 |

## 4. 风险清单（等级 × 缓解）

| # | 风险 | 等级 | 依据 | 缓解 |
|---|---|---|---|---|
| R1 | **matches 禁止通配 host**：C5 的「任意 https 页面可反调扩展」目标不可达；每新增一个 origin 都要改 manifest + 重载/发版，用户无法自助加白 | **阻塞（作主通道）** | F1 官方 | 主通道维持现状；external 仅限已知固定域 |
| R2 | **sender 无 tab**：tool 任务 Q6 第 2 步「调用方页签前缀 `tab<id>__`」失效，审计日志缺 tabId | 高 | F3 高置信 | 退化策略三选一：① tabId=null 时跳过 step-2 直接走 step-3 唯一后缀；② 多候选时要求完整工具名；③ 保留 CS 桥仅用于上报 tabId（丧失直达意义，不推荐） |
| R3 | **localhost matches 命中任意端口**：`http://localhost/*` 下本机其他端口页面（其他 dev server、恶意本地页面）均可尝试通信 | 中-高 | F2 官方 | 显式端口 `http://localhost:5173/*`；运行时 allowlist 双层校验保留 |
| R4 | **无主动下行**（F4）：SW 重启后 Port 断开，重连前终态无法回发；未来进度流推送受限于 Port 生命周期 | 中 | F4 官方 | Port 重连语义照搬现有 host 重连逻辑；页面侧 ack 超时兜底提示 |
| R5 | **节流配额不确定**：心跳/高频消息可能被限 | 中 | F5 待实测 | 心跳本就 pending>0 才发（现状）；落地前用 20s 心跳 + ack 风暴实测 |
| R6 | 暴露面扩大：matches 内页面全量可探测扩展并发消息（指纹/垃圾消息 DoS onMessageExternal） | 低-中 | F1+F6 | 现有结构守卫 + allowlist 已覆盖校验成本；日志观测异常连接 |
| R7 | 双链路维护成本：SDK 分支、测试矩阵、排障路径 ×2 | 中 | 结构性 | transport 抽象收敛在 SDK 单点；单测两链路各保最小集 |
| R8 | 固定扩展 id 依赖 | 低 | F6 + manifest key（L7）已固定 | 无需处理 ✅ |
| R9 | 商店审核：externally_connectable + 明确 matches 是常规形态 | 低 | 官方常规用法 | 无需处理 |

## 5. 收益（若采用，诚实列出）

1. **少一跳**：matches 页面上 SDK→SW 直达，CS 桥旁路，链路与排障更短。
2. **通道级信任**：`sender.origin` 浏览器背书（现有 SW 注入是在我们代码里做信任，external 是浏览器做——少一层自证逻辑）。
3. **信道私密**：不经 window 事件流，页面其他脚本不可见、不可伪造（postMessage 链路的公开性在此消失）。
4. **SW 唤醒**：页面 connect 事件驱动唤醒，比心跳保活更「官方姿势」。

## 6. 判定与建议

1. **主通道维持现状**（postMessage + Port）：R1 阻塞「任意 origin」目标，R2 伤 tool 直调语义，收益换不来覆盖面。
2. **external 定位为「固定域名加速路径」**：html-app 固定域名部署后，manifest 只放行该域 + 显式端口；全部现有校验保留（纵深防御）；Q6 退化选 ②（多候选要求完整名，语义最干净）。
3. **最小落地包**（若做）：M1 + M4 + M5 + M6 + M9 ≈ 中等改动量；M2 的 transport 分流可最后做（先让 SW 双监听跑通，html-app 测试面板加通道徽标验证）。
4. **明确不做**：localhost 通配端口作为通用 dev 通道（R3）；为取 tabId 保留 CS 桥的「假直达」（R2-③）。
5. 事实修正已同步：`docs/extension-tab-communication-channels.md` §3.1 的「放通 all_urls」表述更正为 F1 规则。
