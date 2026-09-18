/// <reference types="@mcp-b/webmcp-types" />
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { createGetStatusTool } from './tools/get-status';
import { buildOrderFormDemo } from './demo/order-form';
import { buildAgentTaskTestPanel } from './agent-task-test';

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
  <section id="tool-registry-panel" class="card" style="margin-top: 16px;">
    <h2 class="tr-title">工具注册管理</h2>
    <p class="tr-status" id="tool-registry-status"></p>
    <div class="tr-actions">
      <button type="button" id="tool-unregister-btn">移除工具注册</button>
      <button type="button" id="tool-register-btn">重新注册工具</button>
    </div>
    <p class="tr-hint">
      移除注册后本页工具对 AI / 侧栏 tools 列表不可见，重新注册即恢复；
      注册状态变化经 toolsChanged 实时广播，侧栏工具列表自动同步。
    </p>
  </section>
  <section id="agent-task-panel-root" class="card" style="margin-top: 16px;"></section>
`;

// ---- 工具定义构建（一次构建，注销后反复注册复用）----
// polyfill registerTool 会对工具描述符做 normalize 拷贝（不写回原对象），
// 因此同一工具定义对象注销后可安全重复注册；FormController/TableController/结果表格
// DOM 也只构建一次，重新注册不会重复挂载 UI。

// 表单填充 + 结果表格工具组（返回 5 个 form_* / query_table_data 工具）
const demoRoot = document.querySelector<HTMLElement>('#demo-root')!;
const formTools = buildOrderFormDemo(demoRoot);

// 页签反调联调测试面板（R5）：验证 window.webmcpAgent C5 通道
buildAgentTaskTestPanel(document.querySelector<HTMLElement>('#agent-task-panel-root')!);

// ---- 注册/注销编排 ----
// 注销机制 = registerTool(tool, { signal }) 传入的 AbortSignal：abort 后 polyfill
// 移除对应工具并广播 toolchange（MCP notifications/tools/list_changed）→
// 扩展桥接转发 toolsChanged → 侧栏工具列表自动刷新。

const registerBtn = document.querySelector<HTMLButtonElement>('#tool-register-btn')!;
const unregisterBtn = document.querySelector<HTMLButtonElement>('#tool-unregister-btn')!;
const statusText = document.querySelector<HTMLParagraphElement>('#tool-registry-status')!;

/** 当前注册批次对应的 AbortController（null = 未注册状态）。 */
let registrationController: AbortController | null = null;
/** 注册流程进行中（异步逐个 registerTool，防并发点击产生重复注册）。 */
let toggling = false;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 同步按钮可用性与状态文案（每次注册/注销前后各刷一次）。 */
function renderState(): void {
  const registered = registrationController !== null;
  // get_status + form_get_schema / form_fill_fields / form_get_values / form_submit / query_table_data
  const toolNames = ['get_status', ...formTools.map((tool) => tool.name)];
  statusText.textContent = registered
    ? `已注册 ${toolNames.length} 个工具：${toolNames.join('、')}`
    : '当前未注册任何工具（AI 与侧栏 tools 列表不可见）';
  unregisterBtn.disabled = !registered || toggling;
  registerBtn.disabled = registered || toggling;
}

/**
 * 注册全部工具（每批一个 AbortController，注销时整体 abort）。
 * 部分注册失败时 abort 已注册部分，不留「半注册」状态。
 */
async function registerAllTools(): Promise<void> {
  // 顶层判空的窄化无法传播进提升的函数声明，此处显式复查（呼应模块头部保护）
  if (!modelContext) {
    throw new Error('WebMCP 未初始化：请确认 polyfill 已正确加载');
  }
  const controller = new AbortController();
  try {
    // 既有示例工具（工厂每次产新定义，规避任何跨批次状态残留）
    await modelContext.registerTool(createGetStatusTool(), { signal: controller.signal });
    for (const tool of formTools) {
      await modelContext.registerTool(tool, { signal: controller.signal });
    }
    registrationController = controller;
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    toggling = false;
    renderState();
  }
}

/** 启动一批注册（按钮与初始注册共用）；失败信息落到状态行。 */
function startRegistration(): void {
  if (registrationController !== null || toggling) return;
  toggling = true;
  renderState();
  void registerAllTools().catch((error: unknown) => {
    statusText.textContent = `注册失败：${describeError(error)}`;
  });
}

registerBtn.addEventListener('click', () => startRegistration());

unregisterBtn.addEventListener('click', () => {
  if (registrationController === null || toggling) return;
  // abort 触发 polyfill 逐工具移除并广播 toolchange（同步派发，无异步等待）
  registrationController.abort();
  registrationController = null;
  renderState();
});

// 启动即注册（沿用原有行为；此时 UI 已构建完成，失败仅提示不阻断页面）
startRegistration();
