// 扩展外壳的 service worker：侧边栏入口行为 + relay 浏览器源编排。
//
// 保持最小化原因：MV3 service worker 随时休眠，状态必须落盘到 storage 或
// 由页面侧（content script / side panel）自持；此处注册的行为均由 Chrome 持久生效。
//
// relay 浏览器源：SW 以「浏览器源」身份直连本机 webmcp-extension-relay
// （ws://127.0.0.1:9333-9348），把各标签页的工具暴露给外部 MCP 客户端；
// 页面端零侵入（无 embed iframe）。连接存续期间 relay 15s 心跳持续重置
// SW 空闲计时，不会休眠；无 relay/无标签页时休眠属预期行为（dormant）。
// 注意：MV3 SW WebSocket 要求 Chrome 116+（manifest minimum_chrome_version 已同步）。
import { startRelayStatusPort, startTabSourceManager } from '../core/tab-source-manager';

/**
 * SW 构建标记：每次改动 SW 相关代码后更新，用于在 SW 控制台确认
 * 浏览器实际加载的是哪个构建（排查「改了代码但行为没变」的 stale dist 问题）。
 */
const SW_BUILD_TAG = 'relay-orch-v3 + tabs-permission + diag (2026-09-06)';
console.info(`[WebMCP] SW boot: ${SW_BUILD_TAG}`);

// 点击工具栏图标时打开侧边栏（行为由浏览器持久记住，无需每次 SW 唤醒都重设也安全，
// 但重复调用幂等，兜底 SW 冷启动场景）。
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
  console.error('[WebMCP] Failed to set side panel behavior:', error);
});

// 标签页源编排：顶层注册保证 SW 每次唤醒都重建监听并重扫已打开页面。
// 构建失败或非 Chrome 环境不应阻断侧边栏入口行为，故 try/catch 兜底。
try {
  const manager = startTabSourceManager();
  // relay 连接状态展示端口：侧边栏经 chrome.runtime.connect 订阅各标签页
  // 连接状态（snapshot 立即下发 + 变更推送），并唤醒 SW。
  startRelayStatusPort(manager);
} catch (error) {
  console.error('[WebMCP] Failed to start tab source manager:', error);
}
