import { describe, expect, it, vi } from 'vitest';
import { API_PATH_EMPTY_HINT, createOpenAiCompatClient, toWireMessages, toWireTools } from './llm-client';
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
