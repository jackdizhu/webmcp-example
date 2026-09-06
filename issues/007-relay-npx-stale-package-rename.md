# 007 · README 安装指引失效：`npx @mcp-b/webmcp-local-relay` 拉到旧包，协议标识不匹配

- **状态**：✅ 已解决（2026-09-06）
- **影响**：`packages/webmcp-extension-relay/README.md`、`packages/webmcp-extension-relay/package.json`

## 现象

按 README 指引执行 `npx @mcp-b/webmcp-local-relay` 启动 relay 后，进程显示运行正常，
但浏览器扩展侧始终看不到 WebSocket 连接（状态停留在「relay 未运行」）。

## 根因

1. 该包已从 `webmcp-local-relay` 改名为 `webmcp-extension-relay`，且**尚未发布到 npm**。
2. `npx` 按旧名称从 registry 拉取旧版本，旧版握手协议标识仍为
   `'webmcp-local-relay'`，而扩展侧严格校验 `'webmcp-extension-relay'` ——
   两端标识不相等，握手直接失败，且旧 CLI 无任何不匹配提示。
3. 旧的 `*` 通配放行也与当前安全模型不符（收紧时应加
   `--widget-origin chrome-extension://<扩展id>`，unpacked 安装需 manifest 固定 key）。

## 修复

- 改用本地构建启动，不走 npm registry：

```bash
pnpm --filter webmcp-extension-relay build
node packages/webmcp-extension-relay/dist/cli.mjs
```

- README 安装章节同步更新为本地构建方式，移除 `npx` 旧指令。

## 经验

1. **改名未发布的包，任何 `npx 旧名` 指引都是隐雷**：npx 只看 registry，会静默拉到
   语义相同但协议不同的旧版本，且握手失败无提示。写文档前先 `npm view <pkg> version`
   确认远端是否包含目标版本。
2. 协议握手标识不匹配时，relay CLI 应打印「收到标识 / 期望标识」，把静默失败变成显式报错（待办）。
