// dify-client 单测：双响应格式解析（blocking JSON / streaming SSE）、错误分型、请求组包。
// fetch 桩覆盖：Content-Type 自适应分派、SSE 跨块边界、message_replace、流内 error、EOF 兜底。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { A2aClientError } from './a2a-client';
import { createDifyClient, DIFY_FALLBACK_USER } from './dify-client';

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
  const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({ event: 'message', answer: '北京今天晴', conversation_id: 'abc-123', metadata: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });
  const client = createDifyClient({ fetchImpl: fetchStub as unknown as typeof fetch });

  beforeEach(() => {
    fetchStub.mockClear();
  });

  it('一次解析 answer / conversation_id；请求体含契约必填字段', async () => {
    const result = await client.chat({ ...baseInput, responseMode: 'blocking' });
    expect(result).toEqual({ answer: '北京今天晴', conversationId: 'abc-123' });
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe(baseInput.endpoint);
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['query']).toBe('帮我查北京天气');
    expect(body['response_mode']).toBe('blocking');
    expect(body['user']).toBe('user-123');
    expect(body['inputs']).toEqual({});
    expect(body['conversation_id']).toBeUndefined();
  });

  it('token 进 Authorization 头；inputs 默认值与 conversation_id 续传透传', async () => {
    await client.chat(
      { ...baseInput, responseMode: 'blocking', inputs: { city: '北京' }, conversationId: 'abc-123' },
      { token: 'app-key-1' }
    );
    const headers = fetchStub.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer app-key-1');
    const body = JSON.parse(fetchStub.mock.calls[0]![1]?.body as string) as Record<string, unknown>;
    expect(body['inputs']).toEqual({ city: '北京' });
    expect(body['conversation_id']).toBe('abc-123');
  });

  it('HTTP 200 + 业务错误负载（有 code/message 无 answer）→ invalid-response', async () => {
    const failing = createDifyClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 'invalid_param', message: '参数异常', status: 400 }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(failing.chat(baseInput)).rejects.toMatchObject({
      kind: 'invalid-response',
      message: expect.stringContaining('参数异常'),
    });
  });

  it('answer 缺失（且非业务错误形态）→ invalid-response', async () => {
    const failing = createDifyClient({
      fetchImpl: (async () => new Response(JSON.stringify({ event: 'message' }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(failing.chat(baseInput)).rejects.toMatchObject({ kind: 'invalid-response' });
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
          sse({ event: 'message_end', conversation_id: 'abc-123', metadata: { usage: {} } }),
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
    expect(result.conversationId).toBe('c-9');
  });

  it('message_replace 整体替换已累积内容（内容审查）', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([
          sse({ event: 'message', answer: '敏感内容' }),
          sse({ event: 'message_replace', answer: '（内容已替换）' }),
          sse({ event: 'message_end' }),
        ])) as unknown as typeof fetch,
    });
    const result = await client.chat(baseInput);
    expect(result.answer).toBe('（内容已替换）');
  });

  it('流内 error 事件 → invalid-response（HTTP 200 也判失败）', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([
          sse({ event: 'message', answer: '部分' }),
          sse({ event: 'error', status: 400, code: 'completion_request_error', message: '文本生成失败' }),
        ])) as unknown as typeof fetch,
    });
    await expect(client.chat(baseInput)).rejects.toMatchObject({
      kind: 'invalid-response',
      message: expect.stringContaining('文本生成失败'),
    });
  });

  it('流自然结束（无 message_end）→ 以已累积内容为结果（EOF 兜底）', async () => {
    const client = createDifyClient({
      fetchImpl: (async () =>
        streamResponse([sse({ event: 'message', answer: '未终止', conversation_id: 'c-eof' })])) as unknown as typeof fetch,
    });
    const result = await client.chat(baseInput);
    expect(result.answer).toBe('未终止');
    expect(result.conversationId).toBe('c-eof');
  });

  it('stream 事件非合法 JSON → invalid-response', async () => {
    const client = createDifyClient({
      fetchImpl: (async () => streamResponse(['data: not-json\n\n'])) as unknown as typeof fetch,
    });
    await expect(client.chat(baseInput)).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('createDifyClient · 错误分型', () => {
  it('非 2xx → http', async () => {
    const client = createDifyClient({
      fetchImpl: (async () => new Response('{"code":"app_unavailable"}', { status: 400 })) as unknown as typeof fetch,
    });
    await expect(client.chat(baseInput)).rejects.toMatchObject({ kind: 'http' });
  });

  it('网络失败 → network', async () => {
    const client = createDifyClient({
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(client.chat(baseInput)).rejects.toMatchObject({ kind: 'network' });
  });

  it('非 HTTP(S) endpoint → invalid-url', async () => {
    const client = createDifyClient({ fetchImpl: fetch });
    await expect(client.chat({ ...baseInput, endpoint: 'ftp://x/chat' })).rejects.toMatchObject({
      kind: 'invalid-url',
    });
  });

  it('错误类型为 A2aClientError（与 jsonrpc 客户端同型，调用方统一分型）', async () => {
    const client = createDifyClient({
      fetchImpl: (async () => new Response('bad', { status: 500 })) as unknown as typeof fetch,
    });
    const error = await client.chat(baseInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(A2aClientError);
  });

  it('user 缺省由消费方兜底常量承载（DIFY_FALLBACK_USER 仅作请求 user 字段默认）', () => {
    expect(DIFY_FALLBACK_USER.length).toBeGreaterThan(0);
  });
});
