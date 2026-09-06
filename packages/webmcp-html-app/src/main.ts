/// <reference types="@mcp-b/webmcp-types" />
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { createGetStatusTool } from './tools/get-status';

// 初始化 WebMCP polyfill（若无原生支持则打补丁，已有原生支持则为 no-op）。
initializeWebMCPPolyfill();

// 向 AI 代理注册本应用的业务工具。
// modelContext 由 polyfill 注入，初始化后必然存在；此处做显式保护，避免严格空值检查报错。
const modelContext = document.modelContext;
if (!modelContext) {
  throw new Error('WebMCP 未初始化：请确认 polyfill 已正确加载');
}
await modelContext.registerTool(createGetStatusTool());

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <p>WebMCP tool "get_status" registered.</p>
`;
