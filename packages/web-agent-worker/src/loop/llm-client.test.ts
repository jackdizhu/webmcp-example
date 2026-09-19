// llm-client 单测：两协议请求组包（apiPath 回退/空串阻断）/ 响应解析（tool_calls / content null）/ 日志红线。
import { describe, expect, it, vi } from 'vitest';
import {
  API_PATH_EMPTY_HINT,
  createAnthropicClient,
  createLlmClient,
  createOpenAiCompatClient,
  toAnthropicMessages,
  type LlmLogFn,
} from './llm-client';
import type { ChatMessage } from './agent-loop';

const openaiConfig = {
  apiKey: 'sk-secret',
  baseUrl: 'https://api.llm.example.test',
  apiPath: '/chat/completions',
  model: 'test-model',
};

const userTurn: ChatMessage[] = [{ role: 'user', content: '你好' }];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 带签名的 fetch 桩工厂（保留调用参数供断言；payload 可覆盖）。 */
function stubFetch(payload: () => Response): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => payload());
}

describe('createOpenAiCompatClient', () => {
  it('请求组包：URL 拼接、Bearer 鉴权、tools 声明', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ choices: [{ message: { content: '好' } }] }));
    const client = createOpenAiCompatClient(openaiConfig, fetchStub as unknown as typeof fetch);
    const reply = await client.complete(userTurn, [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]);
    expect(reply).toEqual({ role: 'assistant', content: '好' });
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe('https://api.llm.example.test/chat/completions');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-secret');
    const body = JSON.parse(init?.body as string) as { model: string; tools: unknown[] };
    expect(body.model).toBe('test-model');
    expect(body.tools).toHaveLength(1);
  });

  it('apiPath 缺省回退 /chat/completions；显式空串阻断请求', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    await createOpenAiCompatClient(
      { apiKey: 'k', baseUrl: 'https://api.llm.example.test', model: 'm' },
      fetchStub as unknown as typeof fetch
    ).complete(userTurn, []);
    expect(fetchStub.mock.calls[0]![0]).toBe('https://api.llm.example.test/chat/completions');
    await expect(
      createOpenAiCompatClient({ ...openaiConfig, apiPath: '' }, fetchStub as unknown as typeof fetch).complete(userTurn, [])
    ).rejects.toThrow(API_PATH_EMPTY_HINT);
    expect(fetchStub).toHaveBeenCalledTimes(1); // 空串未发请求
  });

  it('响应 tool_calls 解析回填；content null 归一空串', async () => {
    const fetchStub = stubFetch(() =>
      jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"v":1}' } }],
          },
        }],
      })
    );
    const client = createOpenAiCompatClient(openaiConfig, fetchStub as unknown as typeof fetch);
    const reply = await client.complete(userTurn, []);
    expect(reply.content).toBe('');
    expect(reply.toolCalls).toMatchObject([{ id: 'c1', function: { name: 'echo', arguments: '{"v":1}' } }]);
  });

  it('HTTP 非 2xx → 抛错且日志 payload 无鉴权信息', async () => {
    const logs: Array<{ level: string; event: string; payload?: unknown }> = [];
    const onLog: LlmLogFn = (level, event, payload) => logs.push({ level, event, payload });
    const fetchStub = stubFetch(() => new Response('denied', { status: 401 }));
    const client = createOpenAiCompatClient(openaiConfig, fetchStub as unknown as typeof fetch, onLog);
    await expect(client.complete(userTurn, [])).rejects.toThrow('HTTP 401');
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('你好');
  });
});

describe('createAnthropicClient', () => {
  it('请求组包：x-api-key 头、system 拆出、tool 消息转 tool_result', async () => {
    const fetchStub = stubFetch(() => jsonResponse({ content: [{ type: 'text', text: '答' }] }));
    const client = createAnthropicClient(
      { apiKey: 'ak-secret', baseUrl: 'https://api.anthropic.example.test', model: 'claude-x', maxTokens: 128 },
      fetchStub as unknown as typeof fetch
    );
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 'echo', arguments: '{"a":1}' } }] },
      { role: 'tool', content: '结果', toolCallId: 'c1' },
    ];
    await client.complete(messages, []);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.example.test/v1/messages');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ak-secret');
    const body = JSON.parse(init?.body as string) as {
      system: string;
      max_tokens: number;
      messages: Array<{ role: string; content: Array<{ type: string }> }>;
    };
    expect(body.system).toBe('sys');
    expect(body.max_tokens).toBe(128);
    // [user '问题', assistant(tool_use), user(tool_result)] — tool_result 承载于 user 侧
    expect(body.messages).toHaveLength(3);
  });

  it('tool_use 块解析回内部 toolCalls 形态（入参 JSON 字符串化）', async () => {
    const client = createAnthropicClient(
      { apiKey: 'k', baseUrl: 'https://x.example.test', model: 'm' },
      stubFetch(() => jsonResponse({ content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { a: 1 } }] })) as unknown as typeof fetch
    );
    const reply = await client.complete(userTurn, []);
    expect(reply.toolCalls).toEqual([{ id: 't1', function: { name: 'echo', arguments: '{"a":1}' } }]);
  });
});

describe('createLlmClient 分派', () => {
  it('apiProtocol=anthropic 分派 anthropic 适配器；缺省 openai-compat', async () => {
    // 桩按调用序回放：第 1 次 anthropic 形态，第 2 次 openai 形态
    const fetchStub = stubFetch(() => jsonResponse({}));
    fetchStub
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'x' }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    const anthropic = createLlmClient(
      { apiKey: 'k', baseUrl: 'https://x.example.test', model: 'm', apiProtocol: 'anthropic' },
      fetchStub as unknown as typeof fetch
    );
    await anthropic.complete(userTurn, []);
    expect((fetchStub.mock.calls[0]![1]?.headers as Record<string, string>)['anthropic-version']).toBeDefined();
    await createLlmClient({ apiKey: 'k', baseUrl: 'https://x.example.test', model: 'm' }, fetchStub as unknown as typeof fetch).complete(userTurn, []);
    const body = JSON.parse(fetchStub.mock.calls[1]![1]?.body as string) as { messages: unknown };
    expect(body.messages).toBeDefined(); // openai 形态
  });
});

describe('toAnthropicMessages', () => {
  it('连续 tool 消息合并进同一条 user 消息', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', function: { name: 'a', arguments: '{}' } },
        { id: 'c2', function: { name: 'b', arguments: '{}' } },
      ] },
      { role: 'tool', content: 'r1', toolCallId: 'c1' },
      { role: 'tool', content: 'r2', toolCallId: 'c2' },
    ]);
    // [user, assistant(tool_use×2), user(tool_result×2 合并)]
    expect(messages).toHaveLength(3);
    expect(messages[2]!.content).toHaveLength(2);
  });
});
