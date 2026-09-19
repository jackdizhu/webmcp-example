// host-status-relay 单测（C7 增强路径汇合层）：广播触发、2s 去重、Q3 预检、
// 自检路径（hostAlive:false 才推送 / true 与探测异常从严跳过）、dispose 清理。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { createHostStatusRelay } from './host-status-relay';

const DISCONNECT_TOOL = 'web_mcp_agent_disconnect';

interface Harness {
  client: Client & { listTools: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> };
  calls: Array<{ name: string; args: unknown }>;
  logs: string[];
  broadcast: (occurredAt?: number) => void;
  replyQuery: (response: unknown, withError?: boolean) => void;
  lastQuery: () => unknown;
}

function createHarness(options: { tools?: string[] } = {}): Harness {
  type RuntimeMessageListener = (message: unknown) => void;
  const runtimeMessageListeners = new Set<RuntimeMessageListener>();
  let sentQuery: unknown = null;
  let respond: ((response: unknown) => void) | null = null;
  const calls: Array<{ name: string; args: unknown }> = [];
  const logs: string[] = [];

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onMessage: {
        addListener: (listener: RuntimeMessageListener) => runtimeMessageListeners.add(listener),
        removeListener: (listener: RuntimeMessageListener) => runtimeMessageListeners.delete(listener),
      },
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        sentQuery = message;
        respond = callback;
      },
    },
  };

  const client = {
    listTools: vi.fn(async () => ({
      tools: (options.tools ?? [DISCONNECT_TOOL]).map((name) => ({
        name,
        description: '',
        inputSchema: { type: 'object' },
      })),
    })),
    callTool: vi.fn(async (request: { name: string; arguments: unknown }) => {
      calls.push({ name: request.name, args: request.arguments });
      return { content: [] };
    }),
  } as unknown as Harness['client'];

  const broadcast = (occurredAt = Date.now()): void => {
    for (const listener of runtimeMessageListeners) {
      listener({ type: 'webmcp-host-status', status: 'unavailable', occurredAt });
    }
  };

  const replyQuery = (response: unknown, withError = false): void => {
    const chromeStub = globalThis as unknown as { chrome: { runtime: { lastError?: unknown } } };
    if (withError) chromeStub.chrome.runtime.lastError = { message: 'Receiving end does not exist' };
    respond?.(response);
    delete chromeStub.chrome.runtime.lastError;
  };

  return { client, calls, logs, broadcast, replyQuery, lastQuery: () => sentQuery };
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.useRealTimers();
});

describe('createHostStatusRelay（C7 汇合层）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('广播 → Q3 预检通过 → callTool 推送断连载荷（version/event/occurredAt）', async () => {
    const h = createHarness();
    const relay = createHostStatusRelay({
      client: h.client,
      onLog: (_level, message) => h.logs.push(message),
      now: () => 10_000,
    });
    h.broadcast();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.listTools).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.name).toBe(DISCONNECT_TOOL);
    const args = h.calls[0]?.args as { version: number; event: string; occurredAt: number };
    expect(args.version).toBe(1);
    expect(args.event).toBe('disconnect');
    expect(typeof args.occurredAt).toBe('number');
    relay.dispose();
  });

  it('2s 去重：窗口内重复广播只推送一次，窗口后恢复', async () => {
    const h = createHarness();
    let clock = 10_000;
    const relay = createHostStatusRelay({ client: h.client, now: () => clock });
    h.broadcast();
    await vi.advanceTimersByTimeAsync(0);
    clock += 1_000;
    h.broadcast();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    clock += 2_001;
    h.broadcast();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(2);
    relay.dispose();
  });

  it('Q3 预检：页面未注册断连工具 → 跳过推送', async () => {
    const h = createHarness({ tools: ['echo', 'get_status'] });
    const relay = createHostStatusRelay({ client: h.client, now: () => 10_000 });
    h.broadcast();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.listTools).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(0);
    relay.dispose();
  });

  it('自检路径：notePanelPortsClosed → 500ms → 查询 → hostAlive:false 才推送', async () => {
    const h = createHarness();
    const relay = createHostStatusRelay({ client: h.client, now: () => 10_000 });
    relay.notePanelPortsClosed();
    await vi.advanceTimersByTimeAsync(499);
    expect(h.lastQuery()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.lastQuery()).toEqual({ type: 'host-status-query' });
    h.replyQuery({ type: 'host-status-reply', hostAlive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(0);
    // 第二轮自检：宿主确实已关闭
    relay.notePanelPortsClosed();
    await vi.advanceTimersByTimeAsync(500);
    h.replyQuery({ type: 'host-status-reply', hostAlive: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    relay.dispose();
  });

  it('自检异常从严：应答缺失（lastError）不推送（宁可漏报不误报）', async () => {
    const h = createHarness();
    const relay = createHostStatusRelay({ client: h.client, now: () => 10_000 });
    relay.notePanelPortsClosed();
    await vi.advanceTimersByTimeAsync(500);
    h.replyQuery(undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(0);
    relay.dispose();
  });

  it('dispose：取消挂起的自检定时器并移除广播监听', async () => {
    const h = createHarness();
    const relay = createHostStatusRelay({ client: h.client, now: () => 10_000 });
    relay.notePanelPortsClosed();
    relay.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.lastQuery()).toBeNull();
    h.broadcast();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(0);
  });
});
