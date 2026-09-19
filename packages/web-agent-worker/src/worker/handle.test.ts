// worker/handle 单测：chat 双格式输出 / init 状态守卫 / run-agent 反向 tool 往返 /
// 临时工具 60s 超时与自动移除 / 并发槽与 agent-busy / 精确取消。
import { describe, expect, it, vi } from 'vitest';
import { createWorkerHandle, AGENT_MAX_CONCURRENCY, TEMP_TOOL_TIMEOUT_MS } from './handle';
import type { WorkerToMainMessage } from '../protocol';

const DIFY_URL = 'https://dify.example.test/v1/chat-messages';
const LLM_URL = 'https://llm.example.test/chat/completions';

const baseConfig = {
  dify: { endpoint: DIFY_URL, apiKey: 'app-x', user: 'u-1', responseMode: 'streaming' as const },
  llm: { apiKey: 'k', baseUrl: 'https://llm.example.test', model: 'm' },
  loop: { maxIterations: 100 },
};

const encoder = new TextEncoder();
const sse = (event: Record<string, unknown>): string => `data: ${JSON.stringify(event)}\n\n`;

function streamResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** openai-compat 响应（content + 可选 tool_calls）。 */
function openAiResponse(
  content: string | null,
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>
): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          content,
          ...(toolCalls !== undefined
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                })),
              }
            : {}),
        },
      }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** 构建被测句柄：fetch 按 URL 分派（LLM 脚本依序回放；Dify 返回 blocking JSON）。 */
function makeHandle(options?: {
  llmScript?: Array<Response>;
  difyResponse?: (init?: RequestInit) => Response | Promise<Response>;
  config?: unknown;
}) {
  const posted: WorkerToMainMessage[] = [];
  const logs: Array<{ level: string; event: string; payload?: unknown }> = [];
  const llmScript = [...(options?.llmScript ?? [])];
  const fetchDispatch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    if (url === LLM_URL) {
      const next = llmScript.shift();
      return next ?? openAiResponse('LLM 脚本耗尽');
    }
    if (url === DIFY_URL) return (options?.difyResponse ?? (() => new Response('{}', { status: 200 })))(init);
    throw new Error(`未知 URL：${String(url)}`);
  };
  const handle = createWorkerHandle({
    post: (message) => posted.push(message),
    fetchImpl: fetchDispatch as unknown as typeof fetch,
    onLog: (level, event, payload) => logs.push({ level, event, payload }),
  });
  const config = options !== undefined && 'config' in options ? options.config : baseConfig;
  if (config !== null) handle.handleMessage({ kind: 'init', config });
  return { posted, logs, handle };
}

/** 微任务冲刷（被测逻辑全 promise 链，无真实定时器等待）。 */
async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('handle · chat 直调', () => {
  it('未 init 收 chat → invalid-state', () => {
    const { posted, handle } = makeHandle({ config: null });
    handle.handleMessage({ kind: 'chat', requestId: 'r1', input: { query: 'q' }, format: 'json' });
    expect(posted).toEqual([
      { kind: 'error', requestId: 'r1', code: 'invalid-state', message: expect.stringContaining('未初始化') },
    ]);
  });

  it("format='sse'：远端 streaming → chunk 逐分片 + done 聚合", async () => {
    const { posted, handle } = makeHandle({
      difyResponse: () =>
        streamResponse([
          sse({ event: 'message', answer: '你', conversation_id: 'c-1' }),
          sse({ event: 'message', answer: '好' }),
          sse({ event: 'message_end', conversation_id: 'c-1' }),
        ]),
    });
    handle.handleMessage({ kind: 'chat', requestId: 'r1', input: { query: 'q' }, format: 'sse' });
    await flush();
    expect(posted).toEqual([
      { kind: 'chunk', requestId: 'r1', event: 'message', delta: '你', conversationId: 'c-1' },
      { kind: 'chunk', requestId: 'r1', event: 'message', delta: '好', conversationId: 'c-1' },
      { kind: 'done', requestId: 'r1', taskKind: 'chat', answer: '你好', conversationId: 'c-1', durationMs: expect.any(Number) },
    ]);
  });

  it("format='json'：远端 blocking → 仅一次 done（无 chunk）；api-key 进 Authorization 头", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const { posted, handle } = makeHandle({
      difyResponse: (init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ answer: '聚合结果', conversation_id: 'c-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    handle.handleMessage({ kind: 'chat', requestId: 'r2', input: { query: 'q' }, format: 'json' });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: 'done', taskKind: 'chat', answer: '聚合结果', conversationId: 'c-2' });
    // 回归断言：init 配置的 api-key 必须以 Authorization: Bearer 形式发出（漏传 = Dify 401）
    expect(capturedHeaders?.['Authorization']).toBe('Bearer app-x');
  });

  it('dify 网络错误 → error(network)；取消中的请求 → error(cancelled)', async () => {
    const { posted, handle } = makeHandle({
      difyResponse: () => {
        throw new Error('boom');
      },
    });
    handle.handleMessage({ kind: 'chat', requestId: 'r3', input: { query: 'q' }, format: 'json' });
    await flush();
    expect(posted[0]).toMatchObject({ kind: 'error', code: 'network' });

    // cancel 语义：dify-client 联合 signal 中断 → 模拟真实 fetch 的 abort reject → 归一 cancelled
    const { posted: cancelPosted, handle: cancelHandle } = makeHandle({
      difyResponse: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('请求已被终止')), { once: true });
        }),
    });
    cancelHandle.handleMessage({ kind: 'chat', requestId: 'r4', input: { query: 'q' }, format: 'json' });
    await flush(6);
    cancelHandle.handleMessage({ kind: 'cancel', requestId: 'r4' });
    await flush();
    expect(cancelPosted.at(-1)).toMatchObject({ kind: 'error', requestId: 'r4', code: 'cancelled' });
  });
});

describe('handle · run-agent（loop 装配 + 反向 tool 往返）', () => {
  it('未配置 llm → agent-disabled', () => {
    const { posted, handle } = makeHandle({
      config: { ...baseConfig, llm: undefined },
    });
    handle.handleMessage({ kind: 'run-agent', requestId: 'a1', input: { message: 'hi' }, tools: [] });
    expect(posted[0]).toMatchObject({ kind: 'error', code: 'agent-disabled' });
  });

  it('临时工具名与 dify 工具冲突 → invalid-state', () => {
    const { posted, handle } = makeHandle({
      config: { ...baseConfig, loop: { difyTools: [{ id: 'x', endpoint: DIFY_URL, apiKey: 'k', user: 'u' }] } },
    });
    handle.handleMessage({
      kind: 'run-agent',
      requestId: 'a1',
      input: { message: 'hi' },
      tools: [{ name: 'dify__x__chat', description: 'd', inputSchema: {} }],
    });
    expect(posted[0]).toMatchObject({ kind: 'error', code: 'invalid-state' });
  });

  it('反向 tool 往返：tool-call 发出 → tool-result 注入 → 循环继续 → done(agent)', async () => {
    const { posted, handle } = makeHandle({
      llmScript: [
        openAiResponse(null, [{ id: 'c1', name: 'get_page_title', args: {} }]),
        openAiResponse('页面标题是 Demo'),
      ],
    });
    handle.handleMessage({
      kind: 'run-agent',
      requestId: 'a2',
      input: { message: '总结页面' },
      tools: [{ name: 'get_page_title', description: '返回标题', inputSchema: { type: 'object' } }],
    });
    await flush();
    expect(posted[0]).toEqual({ kind: 'agent-accepted', requestId: 'a2' });
    expect(posted.some((m) => m.kind === 'tool-call' && m.name === 'get_page_title')).toBe(true);
    const toolCall = posted.find((m) => m.kind === 'tool-call');
    if (toolCall?.kind !== 'tool-call') throw new Error('tool-call 缺失');
    handle.handleMessage({ kind: 'tool-result', requestId: 'a2', toolCallId: toolCall.toolCallId, content: '"Demo 页"' });
    await flush();
    const done = posted.at(-1);
    expect(done).toMatchObject({ kind: 'done', taskKind: 'agent', text: '页面标题是 Demo' });
    if (done?.kind !== 'done' || done.taskKind !== 'agent') throw new Error('done 缺失');
    expect(done.transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(posted.some((m) => m.kind === 'agent-event' && m.event.type === 'tool_result')).toBe(true);
  });

  it('dify 工具在 loop 内直连执行（不产生 tool-call 反向消息）', async () => {
    const { posted, handle } = makeHandle({
      config: {
        ...baseConfig,
        loop: { maxIterations: 100, difyTools: [{ id: 'x', endpoint: DIFY_URL, apiKey: 'k', user: 'u' }] },
      },
      llmScript: [
        openAiResponse(null, [{ id: 'c1', name: 'dify__x__chat', args: { message: '查订单' } }]),
        openAiResponse('订单已发货'),
      ],
      difyResponse: () =>
        new Response(JSON.stringify({ answer: '订单 A001 已发货', conversation_id: 'cv-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    handle.handleMessage({ kind: 'run-agent', requestId: 'a3', input: { message: '帮我查' }, tools: [] });
    await flush();
    expect(posted.some((m) => m.kind === 'tool-call')).toBe(false);
    expect(posted.at(-1)).toMatchObject({ kind: 'done', taskKind: 'agent', text: '订单已发货' });
  });

  it('临时工具 60s 超时：isError 文本回填 + warn 日志 + LLM 清单移除 + 再调防御 + 晚到回执忽略', async () => {
    vi.useFakeTimers();
    try {
      const { posted, logs, handle } = makeHandle({
        llmScript: [
          openAiResponse(null, [{ id: 'c1', name: 'slow_tool', args: {} }]),
          openAiResponse(null, [{ id: 'c2', name: 'slow_tool', args: {} }]),
          openAiResponse('已跳过慢工具'),
        ],
      });
      handle.handleMessage({
        kind: 'run-agent',
        requestId: 'a4',
        input: { message: 'x' },
        tools: [{ name: 'slow_tool', description: '慢', inputSchema: {} }],
      });
      await vi.advanceTimersByTimeAsync(0); // 冲刷至 tool-call 发出
      const toolCall = posted.find((m) => m.kind === 'tool-call');
      if (toolCall?.kind !== 'tool-call') throw new Error('tool-call 缺失');

      await vi.advanceTimersByTimeAsync(TEMP_TOOL_TIMEOUT_MS); // 60s 超时触发
      await vi.advanceTimersByTimeAsync(0); // 后续迭代跑完（再调防御 → 文本回填 → 最终回复）
      expect(logs.some((l) => l.event === 'temp_tool_timeout')).toBe(true);
      expect(posted.some((m) => m.kind === 'agent-event' && m.event.type === 'tool_error')).toBe(true);
      const done = posted.at(-1);
      expect(done).toMatchObject({ kind: 'done', taskKind: 'agent', text: '已跳过慢工具' });

      // 晚到 tool-result（toolCallId 已出表 / 任务已结束）被静默忽略
      expect(() =>
        handle.handleMessage({ kind: 'tool-result', requestId: 'a4', toolCallId: toolCall.toolCallId, content: '"late"' })
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('handle · 并发与取消', () => {
  it(`并发上限 ${AGENT_MAX_CONCURRENCY}：3 槽占满后第 4 个 agent-busy`, async () => {
    // LLM 永远发起对不回执的临时工具调用 → 3 个任务持续在途
    const { posted, handle } = makeHandle({
      llmScript: Array.from({ length: 12 }, (_, i) =>
        openAiResponse(null, [{ id: `c${i}`, name: 'wait_tool', args: {} }])
      ),
    });
    for (let i = 1; i <= AGENT_MAX_CONCURRENCY + 1; i += 1) {
      handle.handleMessage({
        kind: 'run-agent',
        requestId: `a-${i}`,
        input: { message: 'x' },
        tools: [{ name: 'wait_tool', description: 'w', inputSchema: {} }],
      });
    }
    await flush();
    expect(posted.filter((m) => m.kind === 'agent-accepted')).toHaveLength(AGENT_MAX_CONCURRENCY);
    // 超限立即拒绝（在途任务仍会继续发 tool-call，不能断言 at(-1)）
    expect(posted.some((m) => m.kind === 'error' && m.requestId === 'a-4' && m.code === 'agent-busy')).toBe(true);
  });

  it('cancel(requestId) 精确取消：tool-result 注入后下轮边界 error(cancelled)', async () => {
    const { posted, handle } = makeHandle({
      llmScript: [openAiResponse(null, [{ id: 'c1', name: 't', args: {} }])],
    });
    handle.handleMessage({
      kind: 'run-agent',
      requestId: 'a5',
      input: { message: 'x' },
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
    });
    await flush();
    handle.handleMessage({ kind: 'cancel', requestId: 'a5' });
    const toolCall = posted.find((m) => m.kind === 'tool-call');
    if (toolCall?.kind !== 'tool-call') throw new Error('tool-call 缺失');
    handle.handleMessage({ kind: 'tool-result', requestId: 'a5', toolCallId: toolCall.toolCallId, content: '"r"' });
    await flush();
    expect(posted.at(-1)).toMatchObject({ kind: 'error', requestId: 'a5', code: 'cancelled' });
  });

  it('cancel 无参 = 终止全部在途', async () => {
    const { posted, handle } = makeHandle({
      llmScript: [openAiResponse(null, [{ id: 'c1', name: 't', args: {} }])],
    });
    handle.handleMessage({
      kind: 'run-agent',
      requestId: 'a6',
      input: { message: 'x' },
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
    });
    await flush();
    handle.handleMessage({ kind: 'cancel' });
    const toolCall = posted.find((m) => m.kind === 'tool-call');
    if (toolCall?.kind !== 'tool-call') throw new Error('tool-call 缺失');
    handle.handleMessage({ kind: 'tool-result', requestId: 'a6', toolCallId: toolCall.toolCallId, content: '"r"' });
    await flush();
    expect(posted.at(-1)).toMatchObject({ kind: 'error', requestId: 'a6', code: 'cancelled' });
  });
});

