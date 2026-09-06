// 扩展外壳的 MAIN world 入口：在 document_start 把 WebMCP 运行时装进页面。
//
// 这里与页面共享 JavaScript 环境，因此只能放运行时安装逻辑：
// 任何插件特权 API、密钥、凭证都不得进入本文件，它们属于隔离世界的
// `core/content-script.ts`。
//
// `@mcp-b/global` 会优先使用浏览器原生 WebMCP，缺失时才降级到 polyfill。
import '@mcp-b/global';
