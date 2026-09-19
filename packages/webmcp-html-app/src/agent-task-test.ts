// 页签反调联调测试面板（R5，见 docs/webmcp-chrome-extension-tab-invoked-agent-task-explore.md §4.7）。
//
// 职责：在真实页面（html-app dev server，命中扩展注入范围）端到端验证 C5/C6/C7 通道：
// ① 通用智能体 agent 调用（验证 agentName 解析 → runAgentLoop → 工具执行 → 后台会话归档）；
// ② TOOL 调用 chrome_extension_get_document_info（验证 §5.2 解析规则第 1 步 + 结果透传）；
// ③ 拉取初始化数据（C6：SDK asyncAgentInitialization → init-request → 宿主应答 init-data）；
// ④ 推送/断连事件展示（C6 推送路径 + C7 宿主关闭通知经 window CustomEvent 汇入）。
//
// 类型契约：html-app 无法 import 扩展运行时 —— 本文件本地镜像最小类型，
// **唯一事实源 = packages/webmcp-chrome-extension/core/agent-task-protocol.ts 与
// packages/webmcp-agent-chat-core/src/agent-init.ts**，
// 协议改动时双向同步（后续可抽共享类型包）。
// 纯 DOM 操作零框架依赖；window.webmcpAgent 缺失（扩展未安装/未含本特性）时展示就绪提示并禁用按钮。
import type { AgentInitPayloadMirror } from './tools/agent-init';

/** 任务终态结果（协议 AgentTaskResultPayload 的本地镜像）。 */
export interface AgentTaskResultPayload {
  taskId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  result: unknown;
}

/** window.webmcpAgent 的本地镜像类型（协议输入契约同构；C6 扩 asyncAgentInitialization）。 */
export interface WebMcpAgentSdk {
  asyncCreateAgentTask(input:
    | { taskType: 'agent'; agentName: string; agentPrompt: string; skillName?: string }
    | { taskType: 'tool'; toolName: string; toolProps: Record<string, unknown> }
  ): Promise<AgentTaskResultPayload>;
  asyncAgentInitialization(): Promise<AgentInitPayloadMirror>;
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

/** 展示截断上限：格式化后 JSON 体积膨胀（缩进 + 换行），且 C6 初始化载荷含全量工具 schema，2000 常态不够；结果区有 max-height + overflow:auto 滚动兜底。 */
const PREVIEW_LIMIT = 4000;

/** 摘要原文：对象 JSON 格式化（2 空格缩进，保留结构层次）；字符串结果若本身是合法 JSON（如 CallToolResult 的 text 字段）parse 后格式化，否则原样。 */
function formatPreviewSource(result: unknown): string {
  if (typeof result === 'string') {
    try {
      const parsed: unknown = JSON.parse(result);
      if (typeof parsed === 'object' && parsed !== null) return JSON.stringify(parsed, null, 2);
    } catch {
      // 非 JSON 字符串，原样展示
    }
    return result;
  }
  try {
    return JSON.stringify(result, null, 2) ?? 'null';
  } catch {
    return String(result);
  }
}

/** 结果摘要文本：格式化后按上限截断并加尾注（展示用，完整值经 console.debug 输出到控制台）。 */
function preview(result: unknown, limit = PREVIEW_LIMIT): string {
  const raw = formatPreviewSource(result);
  return raw.length > limit
    ? `${raw.slice(0, limit)}\n…（已截断：展示前 ${limit} / 共 ${raw.length} 字符，完整值见控制台）`
    : raw;
}

/** 追加一张结果卡片（成功/失败同区展示，最新在上）。 */
function appendResultCard(results: HTMLElement, heading: string, payload: AgentTaskResultPayload): void {
  console.debug('[agent-task-test] 完整任务结果', payload);
  const card = document.createElement('div');
  card.className = 'at-result-card';
  card.innerHTML = `
    <p class="at-result-head">
      <span class="at-badge at-badge-${escapeHtml(payload.status)}">${escapeHtml(payload.status)}</span>
      <strong>${escapeHtml(heading)}</strong>
    </p>
    <p class="at-meta">taskId: <code>${escapeHtml(payload.taskId)}</code> · sessionId: <code>${escapeHtml(payload.sessionId)}</code></p>
    <pre class="at-result-body">${escapeHtml(preview(payload.result))}</pre>
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

/** 追加一张通道事件卡片（C6 推送 / C7 断连；摘要行 + JSON 截断，最新在上）。 */
function appendChannelEventCard(results: HTMLElement, heading: string, detail: unknown): void {
  console.debug('[agent-task-test] 完整事件载荷', detail);
  const summary = (() => {
    if (typeof detail !== 'object' || detail === null) return '';
    const record = detail as Record<string, unknown>;
    if ('currentAgent' in record) {
      const agent = record['currentAgent'] as { name?: string } | null;
      const agents = Array.isArray(record['agents']) ? record['agents'].length : '?';
      const a2a = Array.isArray(record['a2aAgents']) ? record['a2aAgents'].length : '?';
      const skills = Array.isArray(record['skills']) ? record['skills'].length : '?';
      const tools = Array.isArray(record['tools']) ? record['tools'].length : '?';
      return `激活智能体：${agent ? String(agent.name) : '无'} · agents ${agents} · a2a ${a2a} · skills ${skills} · tools ${tools}`;
    }
    return '';
  })();
  const card = document.createElement('div');
  card.className = 'at-result-card at-event-card';
  card.innerHTML = `
    <p class="at-result-head">
      <span class="at-badge at-badge-completed">event</span>
      <strong>${escapeHtml(heading)}</strong>
    </p>
    ${summary ? `<p class="at-meta">${escapeHtml(summary)}</p>` : ''}
    <pre class="at-result-body">${escapeHtml(preview(detail))}</pre>
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
      ③ 拉取侧栏初始化数据（C6）；侧栏推送与宿主关闭通知（C6/C7）自动展示在结果区。
    </p>
    ${sdk ? '' : '<p class="at-warning">未检测到 window.webmcpAgent：请确认扩展已安装并重新加载本页。</p>'}
    <label class="at-field">
      <span>任务指令（agent 任务）</span>
      <textarea id="at-prompt" rows="3">${AGENT_PROMPT_PRESET}</textarea>
    </label>
    <div class="at-actions">
      <button id="at-run-agent" type="button" ${sdk ? '' : 'disabled'}>① 通用智能体 agent 调用</button>
      <button id="at-run-tool" type="button" ${sdk ? '' : 'disabled'}>② TOOL 调用 get_document_info</button>
      <button id="at-fetch-init" type="button" ${sdk ? '' : 'disabled'}>③ 拉取初始化数据（C6）</button>
    </div>
    <div id="at-results" class="at-results"></div>
  `;

  // 通道事件监听（C6 推送 / C7 断连）：工具落点转 CustomEvent，此处统一展示。
  // 挂在 window 上与面板生命周期一致（重复调用 build 时旧监听随旧 DOM 引用失效，无泄漏积累风险
  // ——listener 引用的 results 属旧面板，新面板重新注册自己的 listener）。
  const results = root.querySelector<HTMLElement>('#at-results');
  if (results) {
    window.addEventListener('webmcp-agent-init-push', (event) => {
      appendChannelEventCard(results, '侧栏推送初始化数据（C6）', (event as CustomEvent).detail);
    });
    window.addEventListener('webmcp-agent-disconnect', (event) => {
      appendChannelEventCard(results, '侧栏宿主已关闭（C7）', (event as CustomEvent).detail);
    });
  }

  if (!sdk) return;
  const promptInput = root.querySelector<HTMLTextAreaElement>('#at-prompt')!;
  const agentButton = root.querySelector<HTMLButtonElement>('#at-run-agent')!;
  const toolButton = root.querySelector<HTMLButtonElement>('#at-run-tool')!;
  const initButton = root.querySelector<HTMLButtonElement>('#at-fetch-init')!;

  const runAgent = async (): Promise<void> => {
    agentButton.disabled = true;
    try {
      const payload = await sdk.asyncCreateAgentTask({
        taskType: 'agent',
        agentName: '通用智能体',
        agentPrompt: promptInput.value.trim() || AGENT_PROMPT_PRESET,
      });
      appendResultCard(results!, '通用智能体 agent 任务', payload);
    } catch (error) {
      appendErrorCard(results!, '通用智能体 agent 任务', error);
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
      appendResultCard(results!, 'chrome_extension_get_document_info', payload);
    } catch (error) {
      appendErrorCard(results!, 'chrome_extension_get_document_info', error);
    } finally {
      toolButton.disabled = false;
    }
  };

  const fetchInit = async (): Promise<void> => {
    initButton.disabled = true;
    try {
      const payload = await sdk.asyncAgentInitialization();
      appendChannelEventCard(results!, '拉取初始化数据（C6 拉取路径）', payload);
    } catch (error) {
      appendErrorCard(results!, '拉取初始化数据（C6）', error);
    } finally {
      initButton.disabled = false;
    }
  };

  agentButton.addEventListener('click', () => void runAgent());
  toolButton.addEventListener('click', () => void runTool());
  initButton.addEventListener('click', () => void fetchInit());
}
