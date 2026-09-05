// 扩展外壳的 service worker：仅负责侧边栏入口行为，不承载任何业务逻辑。
//
// 保持最小化原因：MV3 service worker 随时休眠，状态必须落盘到 storage 或
// 由页面侧（content script / side panel）自持；此处注册的行为均由 Chrome 持久生效。

// 点击工具栏图标时打开侧边栏（行为由浏览器持久记住，无需每次 SW 唤醒都重设也安全，
// 但重复调用幂等，兜底 SW 冷启动场景）。
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
  console.error('[WebMCP] Failed to set side panel behavior:', error);
});
