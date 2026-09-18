// 页签反调联调测试面板（R5，见 docs/webmcp-chrome-extension-tab-invoked-agent-task-explore.md §4.7）。
//
// 职责：在真实页面（html-app dev server，命中扩展注入范围）端到端验证 C5 通道：
// ① 通用智能体 agent 调用（验证 agentName 解析 → runAgentLoop → 工具执行 → 后台会话归档）；
// ② TOOL 调用 chrome_extension_get_document_info（验证 §5.2 解析规则第 1 步 + 结果透传）。
//
// 类型契约：html-app 无法 import 扩展运行时 —— 本文件本地镜像最小类型，
// **唯一事实源 = packages/webmcp-chrome-extension/core/agent-task-protocol.ts**，
// 协议改动时双向同步（后续可抽共享类型包）。
// 纯 DOM 操作零框架依赖；window.webmcpAgent 缺失（扩展未安装/未含本特性）时展示就绪提示并禁用按钮。

/** 任务终态结果（协议 AgentTaskResultPayload 的本地镜像）。 */
export interface AgentTaskResultPayload {
  taskId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  result: unknown;
}

/** window.webmcpAgent 的本地镜像类型（协议输入契约同构）。 */
export interface WebMcpAgentSdk {
  asyncCreateAgentTask(input:
    | { taskType: 'agent'; agentName: string; agentPrompt: string; skillName?: string }
    | { taskType: 'tool'; toolName: string; toolProps: Record<string, unknown> }
  ): Promise<AgentTaskResultPayload>;
}

declare global {
  interface Window {
    webmcpAgent?: WebMcpAgentSdk;
  }
}

/** 按钮 ① 的预设联调指令（可在文本框修改）。 */
const AGENT_PROMPT_PRESET =
  '调用 chrome_extension_get_document_info（includeOutline=true）读取本页大纲，并给出 3 条摘要。';

/** HTML 转义（结果区插入 innerHTML 前统一处理）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 结果摘要文本：对象 JSON 序列化并截断（展示用，完整值看控制台）。 */
function preview(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? 'null';
  } catch {
    return String(result);
  }
}

/** 追加一张结果卡片（成功/失败同区展示，最新在上）。 */
function appendResultCard(results: HTMLElement, heading: string, payload: AgentTaskResultPayload): void {
  const card = document.createElement('div');
  card.className = 'at-result-card';
  card.innerHTML = `
    <p class="at-result-head">
      <span class="at-badge at-badge-${escapeHtml(payload.status)}">${escapeHtml(payload.status)}</span>
      <strong>${escapeHtml(heading)}</strong>
    </p>
    <p class="at-meta">taskId: <code>${escapeHtml(payload.taskId)}</code> · sessionId: <code>${escapeHtml(payload.sessionId)}</code></p>
    <pre class="at-result-body">${escapeHtml(preview(payload.result).slice(0, 2000))}</pre>
  `;
  results.prepend(card);
}

/** 追加一张错误卡片（错误码完整透出，联调顺带验证白名单/侧栏未打开语义）。 */
function appendErrorCard(results: HTMLElement, heading: string, error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  const card = document.createElement('div');
  card.className = 'at-result-card at-result-error';
  card.innerHTML = `
    <p class="at-result-head">
      <span class="at-badge at-badge-failed">${escapeHtml(code)}</span>
      <strong>${escapeHtml(heading)}</strong>
    </p>
    <pre class="at-result-body">${escapeHtml(message)}</pre>
  `;
  results.prepend(card);
}

/**
 * 构建测试面板（main.ts 挂载；重复调用以最后一次为准）。
 * 扩展未注入 SDK 时按钮禁用；按钮点击期间置灰防重复提交。
 */
export function buildAgentTaskTestPanel(root: HTMLElement): void {
  const sdk = window.webmcpAgent;
  root.innerHTML = `
    <h2>页签反调联调（window.webmcpAgent）</h2>
    <p class="at-hint">
      通过扩展 C5 反向通道发起后台 agent / tool 任务：任务默认创建新会话并在侧栏后台运行，
      会话列表可见「运行中 → 终态」状态徽标。origin 需已加入扩展设置页的「页签反调白名单」。
    </p>
    ${sdk ? '' : '<p class="at-warning">未检测到 window.webmcpAgent：请确认扩展已安装并重新加载本页。</p>'}
    <label class="at-field">
      <span>任务指令（agent 任务）</span>
      <textarea id="at-prompt" rows="3">${AGENT_PROMPT_PRESET}</textarea>
    </label>
    <div class="at-actions">
      <button id="at-run-agent" type="button" ${sdk ? '' : 'disabled'}>① 通用智能体 agent 调用</button>
      <button id="at-run-tool" type="button" ${sdk ? '' : 'disabled'}>② TOOL 调用 get_document_info</button>
    </div>
    <div id="at-results" class="at-results"></div>
  `;

  if (!sdk) return;
  const results = root.querySelector<HTMLElement>('#at-results')!;
  const promptInput = root.querySelector<HTMLTextAreaElement>('#at-prompt')!;
  const agentButton = root.querySelector<HTMLButtonElement>('#at-run-agent')!;
  const toolButton = root.querySelector<HTMLButtonElement>('#at-run-tool')!;

  const runAgent = async (): Promise<void> => {
    agentButton.disabled = true;
    try {
      const payload = await sdk.asyncCreateAgentTask({
        taskType: 'agent',
        agentName: '通用智能体',
        agentPrompt: promptInput.value.trim() || AGENT_PROMPT_PRESET,
      });
      appendResultCard(results, '通用智能体 agent 任务', payload);
    } catch (error) {
      appendErrorCard(results, '通用智能体 agent 任务', error);
    } finally {
      agentButton.disabled = false;
    }
  };

  const runTool = async (): Promise<void> => {
    toolButton.disabled = true;
    try {
      const payload = await sdk.asyncCreateAgentTask({
        taskType: 'tool',
        toolName: 'chrome_extension_get_document_info',
        toolProps: { includeOutline: true },
      });
      appendResultCard(results, 'chrome_extension_get_document_info', payload);
    } catch (error) {
      appendErrorCard(results, 'chrome_extension_get_document_info', error);
    } finally {
      toolButton.disabled = false;
    }
  };

  agentButton.addEventListener('click', () => void runAgent());
  toolButton.addEventListener('click', () => void runTool());
}
