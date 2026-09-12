// a2a-tool-source 单测：工具名与校验 / 卡片预取 / 结果分型 / input-required 续传 /
// 兜底轮询 / 串行守卫（2026-09-12 决策 1/2/5）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A2A_POLL_MAX_ATTEMPTS,
  buildA2aSendTaskTool,
  buildA2aToolName,
  createA2aToolSource,
  parseA2aToolName,
  validateA2aAgentId,
  type A2aAgentConfig,
} from './a2a-tool-source';
import { A2aClientError, type A2aClient, type A2aSendResult } from './a2a-client';
import type { A2aTask, AgentCard } from './a2a-types';

const card = (overrides: Partial<AgentCard> = {}): AgentCard => ({
  name: '文档分析智能体',
  description: '分析上传的文档并回答问题',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'https://a2a.example.com/v1', protocolBinding: 'JSONRPC' }],
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'doc-qa', name: '文档问答', description: '基于文档回答问题' }],
  ...overrides,
});

const config = (overrides: Partial<A2aAgentConfig> = {}): A2aAgentConfig => ({
  id: 'doc',
  cardUrl: 'https://a2a.example.com/.well-known/agent-card.json',
  token: 'tok',
  ...overrides,
});

/** A2aClient 全桩（默认：卡片成功、send 返回 completed 任务）。 */
function clientStub(overrides: Partial<A2aClient> = {}): A2aClient & { __calls: string[] } {
  const calls: string[] = [];
  const base: A2aClient = {
    fetchAgentCard: vi.fn(async () => {
      calls.push('fetchAgentCard');
      return card();
    }),
    sendMessage: vi.fn(async (): Promise<A2aSendResult> => {
      calls.push('sendMessage');
      return {
        task: { id: 't1', status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: '分析结果' }] } } },
      };
    }),
    getTask: vi.fn(async (): Promise<A2aTask> => {
      calls.push('getTask');
      return { id: 't1', status: { state: 'completed' } };
    }),
    cancelTask: vi.fn(async (): Promise<A2aTask> => {
      calls.push('cancelTask');
      return { id: 't1', status: { state: 'canceled' } };
    }),
    ...overrides,
  };
  return Object.assign(base, { __calls: calls });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('工具名与 agentKey 校验', () => {
  it('build/parse 往返一致', () => {
    expect(buildA2aToolName('doc')).toBe('a2a__doc__send_task');
    expect(parseA2aToolName('a2a__doc__send_task')).toBe('doc');
    expect(parseA2aToolName('a2a__doc-agent_1__send_task')).toBe('doc-agent_1');
  });

  it('非 a2a__ 命名空间解析为 null', () => {
    expect(parseA2aToolName('chrome_extension_get_document_info')).toBeNull();
    expect(parseA2aToolName('a2a__doc__other')).toBeNull();
    expect(parseA2aToolName('a2a____send_task')).toBeNull();
  });

  it('agentKey 仅允许 [a-zA-Z0-9_-]', () => {
    expect(() => validateA2aAgentId('ok-id_1')).not.toThrow();
    expect(() => validateA2aAgentId('bad id')).toThrow();
    expect(() => validateA2aAgentId('中文')).toThrow();
    expect(() => validateA2aAgentId('')).toThrow();
  });
});

describe('buildA2aSendTaskTool', () => {
  it('description 拼入卡片 name/description 与 skills 摘要，并提示 input-required 续传语义', () => {
    const tool = buildA2aSendTaskTool(config(), card());
    expect(tool.name).toBe('a2a__doc__send_task');
    expect(tool.description).toContain('文档分析智能体');
    expect(tool.description).toContain('分析上传的文档');
    expect(tool.description).toContain('文档问答');
    expect(tool.description).toContain('input-required');
    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['message'] });
  });

  it('endpointOverride 存在时覆盖卡片接口地址（Dify 场景）', async () => {
    const stub = clientStub();
    const source = createA2aToolSource({ client: stub });
    await source.setAgents([
      config({ endpointOverride: 'http://localhost/e/9balyl8c9tebquwb/a2a' }),
    ]);
    await source.callTool('a2a__doc__send_task', { message: '分析' });
    expect(stub.sendMessage).toHaveBeenCalledTimes(1);
    const [endpoint] = (stub.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
    expect(endpoint).toBe('http://localhost/e/9balyl8c9tebquwb/a2a');
  });

  it('缺省 endpointOverride 时回落卡片接口地址', async () => {
    const stub = clientStub();
    const source = createA2aToolSource({ client: stub });
    await source.setAgents([config()]);
    await source.callTool('a2a__doc__send_task', { message: '分析' });
    const [endpoint] = (stub.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string];
    expect(endpoint).toBe('https://a2a.example.com/v1');
  });
});

describe('setAgents / listTools', () => {
  it('卡片抓取成功进清单；失败者不进清单且返回失败列表', async () => {
    const ok = clientStub({
      fetchAgentCard: vi.fn(async (_cardUrl: string) => {
        calls_push();
        if (String(_cardUrl).includes('down.example.com')) {
          throw new A2aClientError('http', 'HTTP 503');
        }
        return card();
      }),
    });
    function calls_push(): void {
      (ok.fetchAgentCard as ReturnType<typeof vi.fn>).mock.calls.length.toString();
    }
    const source = createA2aToolSource({ client: ok });
    const failures = await source.setAgents([
      config(),
      { id: 'bad-net', cardUrl: 'https://down.example.com/card.json' },
      { id: 'bad id!', cardUrl: 'https://x.example.com/card.json' },
    ]);
    // bad-net：卡片抓取失败；bad id!：id 校验失败（不发起请求）
    expect(failures).toEqual(['bad-net', 'bad id!']);
    const tools = source.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('a2a__doc__send_task');
    expect(ok.fetchAgentCard).toHaveBeenCalledTimes(2); // 非法 id 不抓卡片
  });

  it('listTools 在未配置时返回空数组', async () => {
    const source = createA2aToolSource({ client: clientStub() });
    expect(source.listTools()).toEqual([]);
  });
});

describe('callTool 入参与路由', () => {
  it('未知工具名返回 isError', async () => {
    const source = createA2aToolSource({ client: clientStub() });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__ghost__send_task', { message: 'x' });
    expect(result.isError).toBe(true);
  });

  it('卡片抓取失败的 agent 返回 isError（不在可用清单）', async () => {
    const client = clientStub();
    (client.fetchAgentCard as ReturnType<typeof vi.fn>).mockRejectedValue(new A2aClientError('http', 'HTTP 404'));
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__doc__send_task', { message: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('不可用');
  });

  it('缺少 message 返回 isError 且不发起 send', async () => {
    const client = clientStub();
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__doc__send_task', {});
    expect(result.isError).toBe(true);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe('callTool 结果分型', () => {
  it('completed：最终消息 + artifacts 文本化，isError:false', async () => {
    const client = clientStub({
      sendMessage: vi.fn(async () => ({
        task: {
          id: 't1',
          status: { state: 'completed' as const, message: { role: 'agent' as const, parts: [{ kind: 'text' as const, text: '最终结论' }] } },
          artifacts: [{ name: '报告', parts: [{ kind: 'text' as const, text: '附表数据' }] }],
        },
      })),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__doc__send_task', { message: '分析' });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('最终结论');
    expect(result.content[0]!.text).toContain('附表数据');
    // 鉴权信息不进结果文本
    expect(result.content[0]!.text).not.toContain('tok');
  });

  it('直达 message 响应（无 task）文本化即结果', async () => {
    const client = clientStub({
      sendMessage: vi.fn(async () => ({ message: { role: 'agent' as const, parts: [{ kind: 'text' as const, text: '直接回答' }] } })),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__doc__send_task', { message: 'hi' });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toBe('直接回答');
  });

  it('failed：isError:true 且携带状态与远端消息', async () => {
    const client = clientStub({
      sendMessage: vi.fn(async () => ({
        task: { id: 't1', status: { state: 'failed' as const, message: { role: 'agent' as const, parts: [{ kind: 'text' as const, text: '配额不足' }] } } },
      })),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__doc__send_task', { message: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('失败');
    expect(result.content[0]!.text).toContain('配额不足');
    expect(result.content[0]!.text).toContain('t1');
  });

  it('input-required：isError:false，结构化返回 taskId + 问题（决策 2）', async () => {
    const client = clientStub({
      sendMessage: vi.fn(async () => ({
        task: { id: 'task-42', status: { state: 'input-required' as const, message: { role: 'agent' as const, parts: [{ kind: 'text' as const, text: '请提供文档语言' }] } } },
      })),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__doc__send_task', { message: '分析' });
    expect(result.isError).toBe(false);
    const text = result.content[0]!.text;
    expect(text).toContain('input-required');
    expect(text).toContain('taskId: task-42');
    expect(text).toContain('请提供文档语言');
    expect(text).toContain('再次调用');
  });

  it('A2aClientError 分型进 isError 文本', async () => {
    const client = clientStub({
      sendMessage: vi.fn(async () => {
        throw new A2aClientError('rpc', '远端 JSON-RPC 错误（message/send）：任务不存在', -32000);
      }),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const result = await source.callTool('a2a__doc__send_task', { message: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('rpc');
    expect(result.content[0]!.text).toContain('任务不存在');
  });
});

describe('input-required 续传（taskId 透传）', () => {
  it('携 taskId 再次调用时 message/send params 带上 taskId', async () => {
    const client = clientStub();
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    await source.callTool('a2a__doc__send_task', { message: '中文', taskId: 'task-42' });
    // sendMessage 调用签名：[0]=endpoint, [1]=message 对象, [2]=options
    const params = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      role: string;
      parts: unknown[];
      taskId?: string;
    };
    expect(params.taskId).toBe('task-42');
    expect(params.role).toBe('user');
    expect(params.parts[0]).toEqual({ kind: 'text', text: '中文' });
  });

  it('不带 taskId 时不传该字段', async () => {
    const client = clientStub();
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    await source.callTool('a2a__doc__send_task', { message: 'hi' });
    const params = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { taskId?: string };
    expect(params.taskId).toBeUndefined();
  });
});

describe('非终态兜底轮询', () => {
  it('send 返回 working 时按间隔轮询 tasks/get 至终态', async () => {
    vi.useFakeTimers();
    const client = clientStub({
      sendMessage: vi.fn(async () => ({ task: { id: 't1', status: { state: 'working' as const } } })),
      getTask: vi
        .fn()
        .mockResolvedValueOnce({ id: 't1', status: { state: 'working' } })
        .mockResolvedValueOnce({
          id: 't1',
          status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: '轮询后完成' }] } },
        }),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const promise = source.callTool('a2a__doc__send_task', { message: 'x' });
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('轮询后完成');
    expect(client.getTask).toHaveBeenCalledTimes(2);
  });

  it('轮询耗尽仍未终态：isError 并携带 taskId 与当前状态', async () => {
    vi.useFakeTimers();
    const client = clientStub({
      sendMessage: vi.fn(async () => ({ task: { id: 't-long', status: { state: 'working' as const } } })),
      getTask: vi.fn(async () => ({ id: 't-long', status: { state: 'working' as const } })),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const promise = source.callTool('a2a__doc__send_task', { message: 'x' });
    for (let i = 0; i < A2A_POLL_MAX_ATTEMPTS + 1; i += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
    }
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('t-long');
    expect(result.content[0]!.text).toContain('working');
    expect(client.getTask).toHaveBeenCalledTimes(A2A_POLL_MAX_ATTEMPTS);
  });
});

describe('串行守卫（决策 5）', () => {
  it('同一 agent 进行中时再次调用直接 isError，不发起第二次 send', async () => {
    const pending = deferred<A2aSendResult>();
    const client = clientStub({
      sendMessage: vi.fn(async () => pending.promise),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config()]);
    const first = source.callTool('a2a__doc__send_task', { message: '第一个任务' });
    const second = await source.callTool('a2a__doc__send_task', { message: '第二个任务' });
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toContain('串行');
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    pending.resolve({ task: { id: 't1', status: { state: 'completed' } } });
    const firstResult = await first;
    expect(firstResult.isError).toBe(false);
    // 完成后守卫释放，可再次调用
    const third = await source.callTool('a2a__doc__send_task', { message: '第三个任务' });
    expect(third.isError).toBe(false);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('不同 agent 互不阻塞', async () => {
    const pending = deferred<A2aSendResult>();
    const client = clientStub({
      sendMessage: vi.fn(async (endpoint: string): Promise<A2aSendResult> => {
        if (endpoint.includes('slow')) return pending.promise;
        return { task: { id: 't2', status: { state: 'completed' } } };
      }),
    });
    const source = createA2aToolSource({ client });
    await source.setAgents([config(), { id: 'slow', cardUrl: 'https://slow.example.com/card.json' }]);
    const first = source.callTool('a2a__slow__send_task', { message: '慢任务' });
    const other = await source.callTool('a2a__doc__send_task', { message: '快任务' });
    expect(other.isError).toBe(false);
    pending.resolve({ task: { id: 't1', status: { state: 'completed' } } });
    await first;
  });
});
