// client 单测：MessagePort 桩（StubWorker）——ready 排队 / chunk 回调 / 终态 Promise /
// tool-call 分发与异常转 isError / runAgent 回调转发 / terminate。
import { describe, expect, it, vi } from 'vitest';
import { createWebAgentClient, WebAgentRequestError } from './client';
import type { WorkerToMainMessage } from './protocol';

const config = {
  dify: { endpoint: 'https://dify.example.test/v1/chat-messages', apiKey: 'app-x', user: 'u-1' },
};

/** worker 桩：记录出站消息，测试手动注入入站消息。 */
class StubWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message });
  }

  /** 过滤出站消息里指定 kind 的记录（协议形态断言用）。 */
  sent(kind: string): WorkerToMainMessage[] {
    return this.posted.filter((m) => (m as { kind?: string }).kind === kind) as WorkerToMainMessage[];
  }

  /** 取出站消息里指定 kind 首条记录的 requestId（client 侧自增 id 不做硬编码假设）。 */
  requestIdOf(kind: string): string {
    const message = this.sent(kind)[0];
    if (message === undefined || !('requestId' in message)) throw new Error(`出站消息缺少 ${kind}`);
    return (message as { requestId: string }).requestId;
  }
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function makeClient(worker: StubWorker) {
  return createWebAgentClient({ worker: worker as unknown as Worker, config });
}

describe('createWebAgentClient', () => {
  it('ready 前排队缓冲，ready 后先 flush init 再 flush 业务消息', async () => {
    const worker = new StubWorker();
    const client = makeClient(worker);
    const promise = client.chat({ query: 'q' });
    worker.emit({ kind: 'ready' });
    expect(worker.sent('init')).toHaveLength(1);
    expect(worker.sent('chat')).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ kind: 'init' });
    worker.emit({ kind: 'done', requestId: worker.requestIdOf('chat'), taskKind: 'chat', answer: 'a', durationMs: 3 });
    await expect(promise).resolves.toEqual({ answer: 'a', durationMs: 3 });
  });

  it("format='sse'：chunk 转发 onChunk；终态后晚到 chunk 忽略", async () => {
    const worker = new StubWorker();
    const client = makeClient(worker);
    worker.emit({ kind: 'ready' });
    const chunks: string[] = [];
    const promise = client.chat({ query: 'q' }, {
      format: 'sse',
      onChunk: (delta) => chunks.push(delta),
    });
    const requestId = worker.requestIdOf('chat');
    worker.emit({ kind: 'chunk', requestId, event: 'message', delta: '你' });
    worker.emit({ kind: 'chunk', requestId, event: 'message', delta: '好', conversationId: 'c1' });
    worker.emit({ kind: 'done', requestId, taskKind: 'chat', answer: '你好', conversationId: 'c1', durationMs: 5 });
    await expect(promise).resolves.toEqual({ answer: '你好', conversationId: 'c1', durationMs: 5 });
    expect(chunks).toEqual(['你', '好']);
    worker.emit({ kind: 'chunk', requestId, event: 'message', delta: '晚到' });
    expect(chunks).toEqual(['你', '好']);
  });

  it('error 消息 → reject 并携带 code；未知 request 忽略', async () => {
    const worker = new StubWorker();
    const client = makeClient(worker);
    worker.emit({ kind: 'ready' });
    const promise = client.chat({ query: 'q' });
    const chatRequestId = worker.requestIdOf('chat');
    worker.emit({ kind: 'error', requestId: 'wa-req-unknown', code: 'network', message: 'x' });
    worker.emit({ kind: 'error', requestId: chatRequestId, code: 'timeout', message: '超时' });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebAgentRequestError);
    expect((error as WebAgentRequestError).code).toBe('timeout');
    worker.emit({ kind: 'error', requestId: chatRequestId, code: 'network', message: '晚到' });
  });

  it('runAgent：tool-call 分发到 execute；异常转 isError；回执/事件转发；done(agent) resolve', async () => {
    const worker = new StubWorker();
    const client = makeClient(worker);
    worker.emit({ kind: 'ready' });
    const events: string[] = [];
    let acceptedRequestId = '';
    const execute = vi.fn(async () => ({ title: 'Demo 页' }));
    execute.mockRejectedValueOnce(new Error('boom'));
    const promise = client.runAgent(
      { message: '总结' },
      {
        tools: [{ name: 'get_title', description: 'd', inputSchema: {}, execute }],
        onEvent: (event) => events.push(event.type),
        onAccepted: (info) => {
          acceptedRequestId = info.requestId;
        },
      }
    );
    const requestId = worker.requestIdOf('run-agent');
    worker.emit({ kind: 'agent-accepted', requestId });
    expect(acceptedRequestId).toBe(requestId);
    // 第一次调用：execute 抛异常 → isError:true
    worker.emit({ kind: 'tool-call', requestId, toolCallId: 't1', name: 'get_title', args: {} });
    await flush();
    // 第二次调用：正常返回 → 序列化内容
    worker.emit({ kind: 'tool-call', requestId, toolCallId: 't2', name: 'get_title', args: {} });
    await flush();
    const toolResults = worker.sent('tool-result') as unknown as Array<{ content: string; isError: boolean }>;
    expect(toolResults[0]).toMatchObject({ content: 'boom', isError: true });
    expect(toolResults[1]).toMatchObject({ content: '{"title":"Demo 页"}', isError: false });
    worker.emit({ kind: 'agent-event', requestId, event: { type: 'tool_start', name: 'get_title' } });
    expect(events).toContain('tool_start');
    worker.emit({ kind: 'done', requestId, taskKind: 'agent', text: '最终回复', transcript: [{ role: 'user', content: '总结' }] });
    await expect(promise).resolves.toEqual({ text: '最终回复', transcript: [{ role: 'user', content: '总结' }] });
    // 出站 run-agent 消息只携带工具定义（execute 不跨线程）
    const runMessage = worker.sent('run-agent')[0] as unknown as { tools: Array<{ name: string }> };
    expect(runMessage.tools).toEqual([{ name: 'get_title', description: 'd', inputSchema: {} }]);
  });

  it('cancel：带 id / 无参 均出站 cancel 消息', () => {
    const worker = new StubWorker();
    const client = makeClient(worker);
    worker.emit({ kind: 'ready' });
    client.cancel('wa-req-1');
    client.cancel();
    expect(worker.sent('cancel')).toEqual([{ kind: 'cancel', requestId: 'wa-req-1' }, { kind: 'cancel' }]);
  });

  it('terminate：终止 worker 并 reject 全部在途请求', async () => {
    const worker = new StubWorker();
    const client = makeClient(worker);
    worker.emit({ kind: 'ready' });
    const promise = client.chat({ query: 'q' });
    client.terminate();
    expect(worker.terminated).toBe(true);
    const error = await promise.catch((e: unknown) => e);
    expect((error as WebAgentRequestError).code).toBe('cancelled');
  });

  it('非法入站消息：warn 日志且不崩溃', () => {
    const worker = new StubWorker();
    const logs: string[] = [];
    createWebAgentClient({
      worker: worker as unknown as Worker,
      config,
      onLog: (_level, event) => logs.push(event),
    });
    worker.emit({ kind: 'nope' });
    expect(logs).toEqual(['client_message_invalid']);
  });
});
