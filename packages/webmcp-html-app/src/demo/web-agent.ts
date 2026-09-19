// Web Agent Worker 页面调用 Demo：Worker 后台线程调用远程 Agent 接口。
//   - chat（Dify 直调）：流式 text/event-stream 增量分片 / JSON 聚合两种形态切换；
//   - runAgent（loop-agent）：LLM 工具循环 + Dify-as-Tool + 页面临时回调工具，
//     每次发送生成一张任务卡片（过程事件 + 最终响应），可视化最大 3 任务并发。
// 安全默认：endpoint / api-key / user 仅存内存（不落 localStorage）；api-key 只进
// Worker 内存中的 Authorization 头，不落日志。
import {
  createWebAgentClient,
  openLoggerDb,
  WebAgentRequestError,
  type WebAgentClient,
  type WebAgentWorkerConfig,
  type WebAgentTempTool,
} from 'web-agent-worker';
import type { AgentLoopEvent } from 'web-agent-worker';

/** 读取输入框当前值。 */
function inputValue(root: ParentNode, id: string): string {
  return root.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
}

/** 构建 DOM 元素（tag + class + text）。 */
function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 示例临时回调工具：返回当前页面概要（execute 在主线程执行；timestamp 为模型必填入参）。 */
function buildPageInfoTool(): WebAgentTempTool {
  return {
    name: 'get_page_info',
    description: '返回当前页面的标题与可见工具数量（用于让模型了解页面上下文）；调用时必须传入 timestamp 参数',
    inputSchema: {
      type: 'object',
      properties: {
        timestamp: { type: 'string', description: '调用时间戳（ISO 8601 字符串，如 2026-09-19T10:00:00Z）' },
      },
      required: ['timestamp'],
      additionalProperties: false,
    },
    execute: async (args) => {
      // schema 已声明必填；运行时兜底：模型未传时回退当前时间，避免输出 undefined
      const timestamp = typeof args.timestamp === 'string' ? args.timestamp : new Date().toISOString();
      return {
        title: document.title,
        url: location.pathname,
        timestamp,
      };
    },
  };
}

/** 把 loop 过程事件渲染为一行日志文本。 */
function describeAgentEvent(event: AgentLoopEvent): string {
  switch (event.type) {
    case 'llm_call':
      return `[LLM] 第 ${event.iteration} 轮调用`;
    case 'tool_start':
      return `[工具] 调用 ${event.name} …`;
    case 'tool_result':
      return `[工具] ${event.name} ← ${event.result.slice(0, 120)}`;
    case 'tool_error':
      return `[错误] ${event.name}：${event.error}`;
  }
}

/** 从配置区读取当前配置（未校验，交给 worker 侧统一校验报错）。 */
function readConfig(root: ParentNode): WebAgentWorkerConfig {
  const responseMode = root.querySelector<HTMLSelectElement>('#wa-response-mode')?.value;
  const config: WebAgentWorkerConfig = {
    dify: {
      endpoint: inputValue(root, 'wa-endpoint'),
      apiKey: inputValue(root, 'wa-api-key'),
      user: inputValue(root, 'wa-user') || 'webmcp-html-app',
      ...(responseMode === 'blocking' ? { responseMode: 'blocking' as const } : {}),
    },
  };
  const llmBaseUrl = inputValue(root, 'wa-llm-base-url');
  const llmModel = inputValue(root, 'wa-llm-model');
  if (llmBaseUrl.length > 0 && llmModel.length > 0) {
    const protocol = root.querySelector<HTMLSelectElement>('#wa-llm-protocol')?.value;
    config.llm = {
      apiKey: inputValue(root, 'wa-llm-api-key'),
      baseUrl: llmBaseUrl,
      model: llmModel,
      ...(protocol === 'anthropic' ? { apiProtocol: 'anthropic' as const } : {}),
    };
  }
  // Dify-as-Tool（显式开关）：勾选且 Dify 配置齐全时，把 Dify 注册为 agent 可调用工具
  // （init 配置级注册，工具名 dify__<id>__chat；id 非法由 worker 装配期 fail-fast，这里用默认值兜底）
  const asToolEnabled = root.querySelector<HTMLInputElement>('#wa-dify-as-tool')?.checked ?? false;
  if (asToolEnabled) {
    const toolId = inputValue(root, 'wa-dify-tool-id') || 'default';
    config.loop = {
      difyTools: [
        {
          id: toolId,
          endpoint: config.dify.endpoint,
          apiKey: config.dify.apiKey,
          user: config.dify.user,
          ...(responseMode === 'blocking' ? { responseMode: 'blocking' as const } : {}),
        },
      ],
    };
  }
  return config;
}

/** 构建 demo UI（main.ts 接线；不注册 MCP 工具，本期范围 = 页面 UI 调用演示）。 */
export function buildWebAgentDemo(root: HTMLElement): void {
  root.className = 'card';
  root.id = 'web-agent-card';
  root.innerHTML = `
    <h2 class="tr-title">Web Agent Worker 后台调用 Demo</h2>
    <p class="wa-hint">
      浏览器 Web Worker 后台线程调用远程 Agent 接口。Dify / LLM 端点需允许页面跨域（CORS）；
      api-key 仅存内存并只进 Authorization 头。
    </p>
    <div class="wa-config">
      <div class="wa-field"><label>Dify endpoint</label><input id="wa-endpoint" value="http://localhost/v1/chat-messages" /></div>
      <div class="wa-field"><label>Dify api-key</label><input id="wa-api-key" type="password" placeholder="app-xxx" /></div>
      <div class="wa-field"><label>user</label><input id="wa-user" value="webmcp-html-app" /></div>
      <div class="wa-field"><label>responseMode</label>
        <select id="wa-response-mode"><option value="streaming">streaming</option><option value="blocking">blocking</option></select>
      </div>
      <div class="wa-field"><label>LLM baseUrl</label><input id="wa-llm-base-url" value="https://api.deepseek.com" /></div>
      <div class="wa-field"><label>LLM api-key</label><input id="wa-llm-api-key" type="password" /></div>
      <div class="wa-field"><label>LLM model</label><input id="wa-llm-model" placeholder="deepseek-chat" /></div>
      <div class="wa-field"><label>协议</label>
        <select id="wa-llm-protocol"><option value="openai-compat">openai-compat</option><option value="anthropic">anthropic</option></select>
      </div>
    </div>
    <div class="wa-actions">
      <button type="button" id="wa-init-btn">初始化 / 重建 Worker</button>
      <button type="button" id="wa-stop-btn" disabled>停止全部任务</button>
      <button type="button" id="wa-export-logs-btn" title="导出 Worker 调用日志（IndexedDB，滚动保留最近 200 条）">导出调用日志</button>
      <span id="wa-status" class="wa-status"></span>
    </div>

    <div class="wa-section">
      <h3>Dify 直调（chat）</h3>
      <div class="wa-chat-row">
        <input id="wa-chat-query" placeholder="给 Dify 的消息" />
        <label class="wa-radio"><input type="radio" name="wa-format" value="sse" checked />流式 SSE</label>
        <label class="wa-radio"><input type="radio" name="wa-format" value="json" />JSON 聚合</label>
        <button type="button" id="wa-chat-send">发送</button>
      </div>
      <pre id="wa-chat-output" class="wa-output"></pre>
      <p class="wa-meta" id="wa-chat-meta"></p>
      <label class="wa-radio"><input type="checkbox" id="wa-continue" />携带 conversationId 续传</label>
    </div>

    <div class="wa-section">
      <h3>loop-agent（runAgent + 临时回调工具）</h3>
      <p class="wa-hint">
        LLM 工具循环运行在 Worker 线程。勾选「将 Dify 注册为 agent 工具」后，LLM 可调用
        <code>dify__&lt;id&gt;__chat</code> 委派任务给 Dify 应用；页面临时工具 <code>get_page_info</code> 始终可用。
        最大并发 3，超出拒绝（agent-busy）；临时工具超时 60s 自动移除。
      </p>
      <div class="wa-chat-row">
        <input id="wa-agent-message" placeholder="给智能体的任务指令" />
        <button type="button" id="wa-agent-send">发起任务</button>
      </div>
      <div class="wa-chat-row">
        <label class="wa-radio"><input type="checkbox" id="wa-dify-as-tool" checked />将 Dify 注册为 agent 工具</label>
        <input id="wa-dify-tool-id" class="wa-tool-id" value="default" title="工具 id（限 a-zA-Z0-9_-，工具名 = dify__&lt;id&gt;__chat）" />
      </div>
      <div id="wa-agent-tasks" class="wa-tasks"></div>
    </div>
  `;

  const statusText = root.querySelector<HTMLSpanElement>('#wa-status')!;
  const initBtn = root.querySelector<HTMLButtonElement>('#wa-init-btn')!;
  const stopBtn = root.querySelector<HTMLButtonElement>('#wa-stop-btn')!;
  const chatOutput = root.querySelector<HTMLPreElement>('#wa-chat-output')!;
  const chatMeta = root.querySelector<HTMLParagraphElement>('#wa-chat-meta')!;

  let client: WebAgentClient | null = null;
  /** 最近一次 chat 的会话 ID（续传 checkbox 勾选时携带）。 */
  let lastConversationId: string | undefined;

  /** 初始化 / 重建：消费方创建 Worker（new URL 相对路径约束）+ 注入配置。 */
  function initClient(): void {
    client?.terminate();
    const worker = new Worker(new URL('../worker/web-agent-worker-entry.ts', import.meta.url), { type: 'module' });
    client = createWebAgentClient({ worker, config: readConfig(root) });
    statusText.textContent = 'Worker 已初始化（chat 可用；LLM 已配置时 runAgent 可用）';
    stopBtn.disabled = false;
  }

  initBtn.addEventListener('click', () => {
    try {
      initClient();
    } catch (error) {
      statusText.textContent = `初始化失败：${error instanceof Error ? error.message : String(error)}`;
    }
  });

  stopBtn.addEventListener('click', () => {
    client?.cancel(); // 无参 = 终止全部在途（chat + agent）
    statusText.textContent = '已发送停止指令（正在执行的工具等待完成后停止）';
  });

  // ---- 调用日志导出 ----
  const exportLogsBtn = root.querySelector<HTMLButtonElement>('#wa-export-logs-btn')!;

  /** 导出 IndexedDB 调用日志为 JSON 文件（与 Worker 同源，直接读日志库；导出用）。 */
  async function exportCallLogs(): Promise<void> {
    exportLogsBtn.disabled = true;
    try {
      const storage = await openLoggerDb();
      const entries = await storage.readAll();
      const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `web-agent-call-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      statusText.textContent = `已导出 ${entries.length} 条调用日志`;
    } catch (error) {
      statusText.textContent = `导出失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      exportLogsBtn.disabled = false;
    }
  }

  exportLogsBtn.addEventListener('click', () => {
    void exportCallLogs();
  });

  // ---- chat 直调 ----
  root.querySelector<HTMLButtonElement>('#wa-chat-send')!.addEventListener('click', () => {
    if (client === null) {
      chatMeta.textContent = '请先初始化 Worker';
      return;
    }
    const query = inputValue(root, 'wa-chat-query');
    if (query.length === 0) return;
    const format = root.querySelector<HTMLInputElement>('input[name="wa-format"]:checked')?.value === 'sse' ? 'sse' : 'json';
    const useContinue = root.querySelector<HTMLInputElement>('#wa-continue')!.checked;
    chatOutput.textContent = '';
    chatMeta.textContent = '请求中…';
    const startedAt = Date.now();
    void client
      .chat(
        {
          query,
          ...(useContinue && lastConversationId !== undefined ? { conversationId: lastConversationId } : {}),
        },
        {
          format,
          onChunk: (delta, meta) => {
            // message_replace 携带全量替换语义：整体替换已渲染文本
            if (meta.event === 'message_replace') chatOutput.textContent = delta;
            else chatOutput.textContent += delta;
          },
        }
      )
      .then((result) => {
        lastConversationId = result.conversationId ?? lastConversationId;
        chatOutput.textContent = result.answer;
        chatMeta.textContent =
          `耗时 ${result.durationMs}ms` +
          (result.conversationId !== undefined ? ` · conversationId: ${result.conversationId}` : '');
      })
      .catch((error: unknown) => {
        const code = error instanceof WebAgentRequestError ? ` [${error.code}]` : '';
        chatMeta.textContent = `失败${code}：${error instanceof Error ? error.message : String(error)}（${Date.now() - startedAt}ms）`;
      });
  });

  // ---- runAgent（任务卡片） ----
  const taskContainer = root.querySelector<HTMLElement>('#wa-agent-tasks')!;
  root.querySelector<HTMLButtonElement>('#wa-agent-send')!.addEventListener('click', () => {
    if (client === null) {
      statusText.textContent = '请先初始化 Worker';
      return;
    }
    const message = inputValue(root, 'wa-agent-message');
    if (message.length === 0) return;

    const card = el('div', 'wa-task-card');
    const head = el('p', 'wa-task-head');
    const log = el('pre', 'wa-task-log');
    const body = el('p', 'wa-task-body');
    card.append(head, log, body);
    taskContainer.prepend(card);
    head.textContent = '受理中…';

    void client
      .runAgent(
        { message },
        {
          tools: [buildPageInfoTool()],
          onAccepted: (info) => {
            head.textContent = `任务 ${info.requestId} 执行中（可精确 cancel(id)）`;
          },
          onEvent: (event) => {
            log.textContent += `${describeAgentEvent(event)}\n`;
          },
        }
      )
      .then((result) => {
        head.textContent = '任务完成';
        body.textContent = result.text;
      })
      .catch((error: unknown) => {
        const code = error instanceof WebAgentRequestError ? ` [${error.code}]` : '';
        head.textContent = `任务失败${code}`;
        body.textContent = error instanceof Error ? error.message : String(error);
      });
  });
}
