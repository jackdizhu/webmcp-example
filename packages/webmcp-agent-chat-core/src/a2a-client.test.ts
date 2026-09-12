// a2a-client 单测：JSON-RPC 组包 / 错误分型 / 卡片抓取校验 / 鉴权头 / signal 终止。
import { describe, expect, it, vi } from 'vitest';
import { A2aClientError, createA2aClient, type A2aClientDeps } from './a2a-client';

/** 合法卡片响应体。 */
const cardBody = {
  name: '文档分析智能体',
  description: '分析文档',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'https://a2a.example.com/v1', protocolBinding: 'JSONRPC' }],
  capabilities: { streaming: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
};

/** 构造 fetch 桩：按序返回响应；捕获调用记录。 */
function fetchStub(
  responders: Array<(init: RequestInit, url: string) => Response> = [],
  failures: Error[] = []
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const failure = failures.shift();
    if (failure) throw failure;
    const responder = responders.shift();
    if (!responder) throw new Error('fetch stub 未配置该次调用');
    return responder(init ?? {}, url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const deps = (fetchImpl: typeof fetch, onLog?: A2aClientDeps['onLog']): A2aClientDeps => ({ fetchImpl, onLog });

const userMessage = { role: 'user' as const, parts: [{ kind: 'text' as const, text: '分析这份文档' }] };

describe('fetchAgentCard', () => {
  it('GET 抓取 + 校验通过，Accept 头与鉴权头正确携带', async () => {
    const { fetchImpl, calls } = fetchStub([
      () => new Response(JSON.stringify(cardBody), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    const card = await client.fetchAgentCard('https://a2a.example.com/.well-known/agent-card.json', {
      token: 'secret-token',
    });
    expect(card.name).toBe('文档分析智能体');
    expect(calls[0]!.url).toBe('https://a2a.example.com/.well-known/agent-card.json');
    expect((calls[0]!.init.method) === 'GET').toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token');
    expect((calls[0]!.init.headers as Record<string, string>)['Accept']).toBe('application/json');
  });

  it('非 HTTP(S) 的卡片 URL 直接拒绝（invalid-url），不发起请求', async () => {
    const { fetchImpl, calls } = fetchStub();
    const client = createA2aClient(deps(fetchImpl));
    await expect(client.fetchAgentCard('ftp://example.com/card.json')).rejects.toMatchObject({
      kind: 'invalid-url',
    });
    expect(calls).toHaveLength(0);
  });

  it('HTTP 500 分型为 http 错误', async () => {
    const { fetchImpl } = fetchStub([() => new Response('boom', { status: 500 })]);
    const client = createA2aClient(deps(fetchImpl));
    await expect(client.fetchAgentCard('https://a.example.com/card.json')).rejects.toMatchObject({ kind: 'http' });
  });

  it('网络失败分型为 network 错误', async () => {
    const { fetchImpl } = fetchStub([], [new TypeError('fetch failed')]);
    const client = createA2aClient(deps(fetchImpl));
    await expect(client.fetchAgentCard('https://a.example.com/card.json')).rejects.toMatchObject({ kind: 'network' });
  });

  it('响应非 JSON 分型为 invalid-response', async () => {
    const { fetchImpl } = fetchStub([() => new Response('<html>not json</html>', { status: 200 })]);
    const client = createA2aClient(deps(fetchImpl));
    await expect(client.fetchAgentCard('https://a.example.com/card.json')).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('卡片缺必选字段分型为 invalid-response（校验错误透传）', async () => {
    const { fetchImpl } = fetchStub([() => new Response(JSON.stringify({ name: '只有名字' }), { status: 200 })]);
    const client = createA2aClient(deps(fetchImpl));
    await expect(client.fetchAgentCard('https://a.example.com/card.json')).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});

describe('sendMessage', () => {
  it('JSON-RPC 组包正确（jsonrpc/id/method/params），task 型结果识别', async () => {
    const { fetchImpl, calls } = fetchStub([
      () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'task-1', status: { state: 'completed' } } }),
          { status: 200 }
        ),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    const result = await client.sendMessage('https://a2a.example.com/v1', userMessage, { token: 't' });
    expect(result.task?.id).toBe('task-1');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body['jsonrpc']).toBe('2.0');
    expect(body['method']).toBe('message/send');
    expect(body['id']).toEqual(expect.any(Number));
    expect((body['params'] as Record<string, unknown>)['message']).toMatchObject({ role: 'user' });
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer t');
    expect(JSON.stringify(calls[0]!.init.body)).not.toContain('secret'); // token 不落 body
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('message 型结果（直接回答，无 task）识别', async () => {
    const { fetchImpl } = fetchStub([
      () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: '答案' }] } }),
          { status: 200 }
        ),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    const result = await client.sendMessage('https://a2a.example.com/v1', userMessage);
    expect(result.task).toBeUndefined();
    expect(result.message?.parts[0]).toEqual({ kind: 'text', text: '答案' });
  });

  it('JSON-RPC error 分型为 rpc 并保留 code', async () => {
    const { fetchImpl } = fetchStub([
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: '任务不存在' } }), { status: 200 }),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    const error = await client.sendMessage('https://a2a.example.com/v1', userMessage).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(A2aClientError);
    expect((error as A2aClientError).kind).toBe('rpc');
    expect((error as A2aClientError).rpcCode).toBe(-32000);
    expect((error as A2aClientError).message).toContain('任务不存在');
  });

  it('result 既非 task 也非 message 分型为 invalid-response', async () => {
    const { fetchImpl } = fetchStub([
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 42 }), { status: 200 }),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    await expect(client.sendMessage('https://a2a.example.com/v1', userMessage)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});

describe('getTask / cancelTask', () => {
  it('getTask 返回校验后的 task；入参 id 进 params', async () => {
    const { fetchImpl, calls } = fetchStub([
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 't9', status: { state: 'working' } } }), { status: 200 }),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    const task = await client.getTask('https://a2a.example.com/v1', 't9');
    expect(task.status.state).toBe('working');
    const body = JSON.parse(String(calls[0]!.init.body)) as { params: { id: string } };
    expect(body.params.id).toBe('t9');
    expect(JSON.parse(String(calls[0]!.init.body)).method).toBe('tasks/get');
  });

  it('getTask 结果非法分型为 invalid-response', async () => {
    const { fetchImpl } = fetchStub([
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { nope: true } }), { status: 200 }),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    await expect(client.getTask('https://a2a.example.com/v1', 't9')).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('cancelTask 正常返回 task', async () => {
    const { fetchImpl } = fetchStub([
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 't9', status: { state: 'canceled' } } }), { status: 200 }),
    ]);
    const client = createA2aClient(deps(fetchImpl));
    const task = await client.cancelTask('https://a2a.example.com/v1', 't9');
    expect(task.status.state).toBe('canceled');
  });
});

describe('signal 与日志红线', () => {
  it('外部 signal 已中止时请求前即失败（network 分型）', async () => {
    const { fetchImpl } = fetchStub();
    const client = createA2aClient(deps(fetchImpl));
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.fetchAgentCard('https://a.example.com/card.json', { signal: controller.signal })
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('onLog 只见 URL/方法/状态/耗时，不见鉴权信息', async () => {
    const onLog = vi.fn();
    const { fetchImpl } = fetchStub([
      () => new Response(JSON.stringify(cardBody), { status: 200 }),
    ]);
    const client = createA2aClient(deps(fetchImpl, onLog));
    await client.fetchAgentCard('https://a.example.com/card.json', { token: 'super-secret' });
    expect(onLog).toHaveBeenCalled();
    const payload = JSON.stringify(onLog.mock.calls);
    expect(payload).not.toContain('super-secret');
    expect(payload).toContain('a.example.com');
  });
});
