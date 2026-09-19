// dify-client 单测（自包含移植版）：双响应格式解析、错误分型、请求组包、onChunk 分片回调。
import { describe, expect, it, vi } from 'vitest';
import { createDifyClient, DIFY_REQUEST_TIMEOUT_MS } from './dify-client';
import { WebAgentWorkerError } from '../protocol';

const encoder = new TextEncoder();

const baseInput = {
  endpoint: 'https://api.dify.example.com/v1/chat-messages',
  query: '帮我查北京天气',
  responseMode: 'streaming' as const,
  user: 'user-123',
  inputs: {},
};

/** 构造 SSE chunk 文本（data: JSON\n\n 帧）。 */
const sse = (event: Record<string, unknown>): string => `data: ${JSON.stringify(event)}\n\n`;

/** 流式响应桩（按给定 chunk 序列回放）。 */
function streamResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': contentType } });
}

describe('createDifyClient · blocking（application/json）', () => {
  it('一次解析 answer / conversation_id；请求体含契约必填字段', async () => {
    const fetchStub = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ event: 'message', answer: '北京今天晴', conversation_id: 'abc-123', metadata: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const client = createDifyClient({ fetchImpl: fetchStub as unknown as typeof fetch });
    const result = await client.chat({ ...baseInput, responseMode: 'blocking' });
    expect(result).toEqual({ answer: '北京今天晴', conversationId: 'abc-123' });
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe(baseInput.endpoint);
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['query']).toBe('帮我查北京天气');
    expect(body['response_mode']).toBe('blocking');
    expect(body['user']).toBe('user-123');
    expect(body['conversation_id']).toBeUndefined();
  });

  it('token 只进 Authorization 头；inputs 与 conversation_id 续传透传', async () => {
    const fetchStub = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ answer: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const client = createDifyClient({ fetchImpl: fetchStub as unknown as typeof fetch });
    await client.chat({ ...baseInput, responseMode: 'blocking', inputs: { city: '北京' }, conversationId: 'abc-123' }, { token: 'app-key-1' });
    const headers = fetchStub.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer app-key-1');
    const body = JSON.parse(fetchStub.mock.calls[0]![1]?.body as string) as Record<string, unknown>;
    expect(body['inputs']).toEqual({ city: '北京' });
    expect(body['conversation_id']).toBe('abc-123');
  });

  it('HTTP 200 + 业务错误负载（有 code/message 无 answer）→ invalid-response', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 'invalid_param', message: '参数异常', status: 400 }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(client.chat(baseInput)).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('参数异常'),
    });
  });

  it('非 HTTP(S) 端点 → invalid-url', async () => {
    const client = createDifyClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(client.chat({ ...baseInput, endpoint: 'ftp://x' })).rejects.toMatchObject({ code: 'invalid-url' });
  });
});

describe('createDifyClient · streaming（text/event-stream）', () => {
  it('message/agent_message 累积 answer，message_end 终止，ping 忽略', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([
          sse({ event: 'message', answer: '北京今天', conversation_id: 'abc-123' }),
          sse({ event: 'ping' }),
          sse({ event: 'agent_message', answer: '晴，' }),
          sse({ event: 'message_end', conversation_id: 'abc-123' }),
        ])) as unknown as typeof fetch,
    });
    const result = await client.chat(baseInput);
    expect(result.answer).toBe('北京今天晴，');
    expect(result.conversationId).toBe('abc-123');
  });

  it('SSE 帧跨 fetch 块边界仍可正确分帧', async () => {
    const full = sse({ event: 'message', answer: '分帧', conversation_id: 'c-9' });
    const mid = Math.floor(full.length / 2);
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([full.slice(0, mid), full.slice(mid), sse({ event: 'message_end' })])) as unknown as typeof fetch,
    });
    const result = await client.chat(baseInput);
    expect(result.answer).toBe('分帧');
  });

  it('同一事件块内多行 data: 行按 SSE 规范合并为单个事件', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([
          // data 跨两行（JSON 在逗号后断行，合并后仍为合法 JSON）
          'data: {"event": "message",\ndata: "answer": "多行", "conversation_id": "c-m"}\n\n',
          sse({ event: 'message_end' }),
        ])) as unknown as typeof fetch,
    });
    const result = await client.chat(baseInput);
    expect(result.answer).toBe('多行');
    expect(result.conversationId).toBe('c-m');
  });

  it('message_replace 整体替换已累积内容（内容审查）', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([
          sse({ event: 'message', answer: '敏感词' }),
          sse({ event: 'message_replace', answer: '***(已替换)' }),
          sse({ event: 'message_end' }),
        ])) as unknown as typeof fetch,
    });
    const result = await client.chat(baseInput);
    expect(result.answer).toBe('***(已替换)');
  });

  it('onChunk 实时回调：文本分片逐个发出，message_replace 携全量替换', async () => {
    const chunks: Array<{ event: string; delta: string; conversationId?: string }> = [];
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([
          sse({ event: 'message', answer: '你', conversation_id: 'c-1' }),
          sse({ event: 'message_replace', answer: '**' }),
          sse({ event: 'message_end' }),
        ])) as unknown as typeof fetch,
    });
    await client.chat(baseInput, {
      onChunk: (chunk) => {
        chunks.push({ event: chunk.event, delta: chunk.delta, ...(chunk.conversationId !== undefined ? { conversationId: chunk.conversationId } : {}) });
      },
    });
    expect(chunks).toEqual([
      { event: 'message', delta: '你', conversationId: 'c-1' },
      { event: 'message_replace', delta: '**', conversationId: 'c-1' },
    ]);
  });

  it('流内 error 事件 → invalid-response', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([sse({ event: 'error', message: '配额不足' })])) as unknown as typeof fetch,
    });
    await expect(client.chat(baseInput)).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('配额不足'),
    });
  });

  it('错误对象为 WebAgentWorkerError（自包含错误类型）', async () => {
    const client = createDifyClient({
      fetchImpl: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch,
    });
    const error = await client.chat(baseInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebAgentWorkerError);
    expect((error as WebAgentWorkerError).code).toBe('http');
  });

  it('默认超时常量对齐 120s', () => {
    expect(DIFY_REQUEST_TIMEOUT_MS).toBe(120_000);
  });
});
