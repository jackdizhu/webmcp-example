/// <reference types="@mcp-b/webmcp-types" />
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { createGetStatusTool } from './tools/get-status';
import { buildOrderFormDemo } from './demo/order-form';

// 初始化 WebMCP polyfill（若无原生支持则打补丁，已有原生支持则为 no-op）。
initializeWebMCPPolyfill();

// 向 AI 代理注册本应用的业务工具。
// modelContext 由 polyfill 注入，初始化后必然存在；此处做显式保护，避免严格空值检查报错。
const modelContext = document.modelContext;
if (!modelContext) {
  throw new Error('WebMCP 未初始化：请确认 polyfill 已正确加载');
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <h1>WebMCP 表单填充 Demo</h1>
  <p class="subtitle">AI 通过页面注册的 MCP 工具完成「读 schema → 填表单 → 提交复核」闭环，并查询订单结果表格。</p>
  <div id="demo-root"></div>
`;

// 既有示例工具
await modelContext.registerTool(createGetStatusTool());

// 表单填充 + 结果表格工具组
const demoRoot = document.querySelector<HTMLElement>('#demo-root')!;
const formTools = buildOrderFormDemo(demoRoot);
for (const tool of formTools) {
  await modelContext.registerTool(tool);
}
