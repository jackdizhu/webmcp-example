# 008 · Service Worker loopback WebSocket 被 Chrome LNA 静默拦截（ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS）

- **状态**：✅ 已解决（2026-09-06，检测 + 提示）
- **影响**：`core/relay-source-client.ts`、`core/relay-lna-permission.ts`（新增）、
  `main-extension/side-panel/components/RelayStatusBar.ts`

## 现象

relay 进程已启动且经 `node` 模拟握手验证可达（`ws://127.0.0.1:<port>` 端口监听正常），
但扩展 Service Worker 发起的 WebSocket **从未建立**——无连接日志、无错误弹窗，
侧栏状态表现为 relay 未运行/重连中，与「relay 进程正常」的观察直接矛盾。

## 根因

**Chrome LNA（Local Network Access）**：

- Chrome 142 起强制执行，147 扩展到 WebSocket。
- `chrome-extension://` 被归类为 **public origin**，其 SW 访问 loopback
  （`ws://127.0.0.1`）属于 public → local 请求，被
  `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` 静默拒绝。
- 关键坑：**该场景没有任何用户可见的权限弹窗**，失败只在 SW console 里体现，
  极易与「relay 没启动」「端口错了」混淆。

## 修复

无法从扩展内部绕过（这是浏览器安全策略），改为**检测 + 引导**：

1. 新增 `core/relay-lna-permission.ts`：用 Permissions API 查询授权状态，
   按版本回退别名——
   - Chrome 145+：`navigator.permissions.query({ name: 'loopback-network' })`
   - Chrome 142–144：别名 `'local-network-access'`
   - 更早版本：返回 `unsupported`
2. `RelayConnectionStatus` 增加可选 `lnaBlocked` 字段：`enterDormant()` 后异步检测
   （dormant 守卫 + 去重 + 过期结果丢弃），非 `granted` 时置位并在 `detail`
   注入修复路径；`activateSocket` / `wake` 成功时复位。
3. 侧栏 `RelayStatusBar` 摘要行新增**琥珀色**提示：
   「relay 被浏览器本地网络权限拦截 · 展开查看修复步骤」。

**用户侧修复步骤**：`chrome://extensions` → 扩展详情 → 网站设置 →
本地网络访问 = 允许。

## 验证注意

- LNA 拦截发生在「发起连接」阶段，`netstat` 看 relay 端口有 TIME_WAIT/ESTABLISHED
  不代表 SW 的 WS 已建立——需区分「TCP 层可达」与「WebSocket 层被拦」。
- 若观察到 TCP 交互但握手消息没到（如 009 所述的 Port 竞争问题），说明 LNA 已放行，
  应换方向排查。

## 经验

1. **Chrome 新安全策略（LNA/PNA）是扩展 SW loopback 通信的第一嫌疑对象**：
   静默失败 + 无弹窗，比网络故障更难定位。
2. 排障顺序建议：先看 SW console 的具体报错码
   （`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` 一锤定音），再做端口/进程排查。
