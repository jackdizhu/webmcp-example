import { describe, expect, it, vi } from 'vitest';
import {
  API_PATH_EMPTY_HINT,
  createAnthropicClient,
  createLlmClient,
  createOpenAiCompatClient,
  toAnthropicMessages,
  toWireMessages,
  toWireTools,
} from './llm-client';
import type { AgentTool } from './agent-loop';

const fetchStub = vi.fn<typeof fetch>();

describe('createOpenAiCompatClient', () => {
  it('以正确 URL、鉴权头与工具声明发起 chat completions 请求', async () => {
    fetchStub.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const client = createOpenAiCompatClient(
      { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1/', model: 'test-model' },
      fetchStub
    );

    const result = await client.complete([{ role: 'user', content: '你好' }], [
      { name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } },
    ]);

    expect(result).toEqual({ role: 'assistant', content: 'ok' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string) as {
      model: string;
      tools: Array<{ type: string; function: { name: string } }>;
    };
    expect(body.model).toBe('test-model');
    expect(body.tools[0]?.function.name).toBe('get_status');
  });

  it('apiPath 未配置时回退默认 /chat/completions', async () => {
    fetchStub.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const client = createOpenAiCompatClient({ apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm' }, fetchStub);

    await client.complete([{ role: 'user', content: 'hi' }], []);

    const [url] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('apiPath 自定义路径生效并自动补全前导斜杠', async () => {
    fetchStub.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const client = createOpenAiCompatClient(
      { apiKey: 'k', baseUrl: 'https://api.example.com', apiPath: 'v1/chat/completions', model: 'm' },
      fetchStub
    );

    await client.complete([{ role: 'user', content: 'hi' }], []);

    const [url] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('apiPath 显式空串不回退默认路径，直接抛出配置提示且不发请求', async () => {
    const client = createOpenAiCompatClient(
      { apiKey: 'k', baseUrl: 'https://api.example.com', apiPath: '', model: 'm' },
      fetchStub
    );

    await expect(client.complete([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(API_PATH_EMPTY_HINT);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('无工具时省略 tools 字段以兼容敏感服务端', async () => {
    fetchStub.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const client = createOpenAiCompatClient({ apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm' }, fetchStub);

    await client.complete([{ role: 'user', content: 'hi' }], []);

    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect('tools' in body).toBe(false);
  });

  it('非 2xx 响应抛出含状态码的错误', async () => {
    fetchStub.mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 }));
    const client = createOpenAiCompatClient({ apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm' }, fetchStub);

    await expect(client.complete([], [])).rejects.toThrow('HTTP 401');
  });

  it('响应缺失 choices 时抛出可读错误', async () => {
    fetchStub.mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createOpenAiCompatClient({ apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm' }, fetchStub);

    await expect(client.complete([], [])).rejects.toThrow('choices[0].message');
  });
});

describe('wire 转换', () => {
  it('toWireMessages 保留 tool_calls 与 tool_call_id', () => {
    const wire = toWireMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', content: '{}', toolCallId: 'c1' },
    ]);
    expect(wire[0]?.tool_calls?.[0]?.id).toBe('c1');
    expect(wire[1]?.tool_call_id).toBe('c1');
  });

  it('toWireTools 把 inputSchema 放入 parameters', () => {
    const schema = { type: 'object', properties: {} };
    const tools: AgentTool[] = [{ name: 't', description: 'd', inputSchema: schema }];
    expect(toWireTools(tools)[0]?.function.parameters).toEqual(schema);
  });
});

describe('createAnthropicClient', () => {
  it('以 /v1/messages、x-api-key 鉴权头与 input_schema 工具声明发起请求', async () => {
    fetchStub.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
    );
    const client = createAnthropicClient(
      { apiKey: 'ak-test', baseUrl: 'https://api.anthropic.com', model: 'claude-test' },
      fetchStub
    );

    const result = await client.complete([{ role: 'user', content: '你好' }], [
      { name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } },
    ]);

    expect(result).toEqual({ role: 'assistant', content: 'ok' });
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('ak-test');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string) as {
      model: string;
      max_tokens: number;
      tools: Array<{ name: string; input_schema: unknown }>;
    };
    expect(body.model).toBe('claude-test');
    expect(body.max_tokens).toBe(4096); // 协议必填，缺省 4096
    expect(body.tools[0]?.input_schema).toEqual({ type: 'object' });
  });

  it('system 独立拆出、max_tokens 使用配置值', async () => {
    fetchStub.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
    );
    const client = createAnthropicClient(
      { apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm', maxTokens: 1024 },
      fetchStub
    );

    await client.complete(
      [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: 'hi' },
      ],
      []
    );

    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      system?: string;
      max_tokens: number;
      messages: Array<{ role: string }>;
    };
    expect(body.system).toBe('你是助手');
    expect(body.max_tokens).toBe(1024);
    expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('tool_use 响应块转换为内部 toolCalls（input 对象序列化为 JSON 字符串）', async () => {
    fetchStub.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: 'text', text: '查一下' },
            { type: 'tool_use', id: 'tu-1', name: 'get_status', input: { a: 1 } },
          ],
        }),
        { status: 200 }
      )
    );
    const client = createAnthropicClient(
      { apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm' },
      fetchStub
    );

    const result = await client.complete([{ role: 'user', content: 'hi' }], []);

    expect(result.role).toBe('assistant');
    expect(result.content).toBe('查一下');
    expect(result.toolCalls?.[0]).toEqual({
      id: 'tu-1',
      function: { name: 'get_status', arguments: '{"a":1}' },
    });
  });

  it('tool 消息转换为 user 侧 tool_result 块，连续 tool 消息合并', async () => {
    fetchStub.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
    );
    const client = createAnthropicClient(
      { apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm' },
      fetchStub
    );

    await client.complete(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', function: { name: 'a', arguments: '{}' } }, { id: 't2', function: { name: 'b', arguments: '{}' } }] },
        { role: 'tool', content: 'r1', toolCallId: 't1' },
        { role: 'tool', content: 'r2', toolCallId: 't2' },
      ],
      []
    );

    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; content?: string }> }>;
    };
    const toolResultMessages = body.messages.filter((m) => m.content[0]?.type === 'tool_result');
    expect(toolResultMessages).toHaveLength(1); // 连续 tool 消息合并为一条 user 消息
    expect(toolResultMessages[0]?.content).toHaveLength(2);
  });

  it('apiPath 显式空串不回退默认路径，直接抛出提示且不发请求', async () => {
    const client = createAnthropicClient(
      { apiKey: 'k', baseUrl: 'https://api.anthropic.com', apiPath: '', model: 'm' },
      fetchStub
    );

    await expect(client.complete([{ role: 'user', content: 'hi' }], [])).rejects.toThrow('/v1/messages');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('非 2xx 响应抛出含状态码的错误', async () => {
    fetchStub.mockResolvedValue(new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    const client = createAnthropicClient(
      { apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm' },
      fetchStub
    );

    await expect(client.complete([], [])).rejects.toThrow('HTTP 401');
  });
});

describe('toAnthropicMessages', () => {
  it('assistant tool_calls 转为 tool_use 块（arguments 字符串 → input 对象）', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 't', arguments: '{"x":2}' } }] },
    ]);
    expect(messages[0]?.content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 't', input: { x: 2 } });
  });

  it('arguments 非法 JSON 时回填空对象不抛错', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 't', arguments: 'not-json' } }] },
    ]);
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });
});

describe('createLlmClient 分发', () => {
  it('apiProtocol=anthropic 分发到 Anthropic 适配器', async () => {
    fetchStub.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
    );
    const client = createLlmClient(
      { apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm', apiProtocol: 'anthropic' },
      fetchStub
    );

    await client.complete([{ role: 'user', content: 'hi' }], []);

    const [url] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('apiProtocol 缺省回退 openai-compat（兼容存量配置）', async () => {
    fetchStub.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    );
    const client = createLlmClient(
      { apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm' },
      fetchStub
    );

    await client.complete([{ role: 'user', content: 'hi' }], []);

    const [url] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });
});
