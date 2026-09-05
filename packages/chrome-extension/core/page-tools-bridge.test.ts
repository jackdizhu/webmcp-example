import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAGE_TOOLS_PORT_NAME,
  serializeToolResult,
  startPageToolsBridge,
} from './page-tools-bridge';

/** 桥接测试桩：伪造 chrome.runtime.onConnect 与 Port 行为。 */
function createHarness() {
  type ConnectListener = (port: unknown) => void;
  const connectListeners = new Set<ConnectListener>();

  type MessageListener = (message: unknown) => void;
  let messageListener: MessageListener | null = null;

  const posted: unknown[] = [];

  const fakePort = {
    name: PAGE_TOOLS_PORT_NAME,
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    disconnect: vi.fn(),
    onMessage: {
      addListener: (listener: MessageListener) => {
        messageListener = listener;
      },
      removeListener: () => {
        messageListener = null;
      },
    },
    onDisconnect: {
      addListener: () => {},
      removeListener: () => {},
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onConnect: {
        addListener: (listener: ConnectListener) => connectListeners.add(listener),
        removeListener: (listener: ConnectListener) => connectListeners.delete(listener),
      },
    },
  };

  const connect = (): void => {
    for (const listener of connectListeners) listener(fakePort);
  };

  /** 以自定义端口名模拟其他扩展上下文接入。 */
  const connectAs = (name: string): void => {
    for (const listener of connectListeners) listener({ ...fakePort, name });
  };

  const dispatch = (message: unknown): void => {
    messageListener?.(message);
  };

  return { posted, connect, connectAs, dispatch };
}

const fakeClient = {
  listTools: vi.fn(async () => ({
    tools: [{ name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } }],
  })),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] })),
} as unknown as import('@modelcontextprotocol/client').Client;

afterEach(() => {
  vi.clearAllMocks();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('startPageToolsBridge', () => {
  it('listTools 请求被代理到 MCP Client 并回传工具清单', async () => {
    const harness = createHarness();
    const stop = startPageToolsBridge(fakeClient);
    harness.connect();

    harness.dispatch({ id: 1, type: 'listTools' });
    await vi.waitFor(() => {
      expect(harness.posted.length).toBe(1);
    });

    const response = harness.posted[0] as { id: number; ok: boolean; result: Array<{ name: string }> };
    expect(response.id).toBe(1);
    expect(response.ok).toBe(true);
    expect(response.result[0]?.name).toBe('get_status');
    stop();
  });

  it('callTool 请求把 name 与 args 透传给 MCP Client', async () => {
    const harness = createHarness();
    const stop = startPageToolsBridge(fakeClient);
    harness.connect();

    harness.dispatch({ id: 2, type: 'callTool', name: 'get_status', args: { verbose: true } });
    await vi.waitFor(() => {
      expect(harness.posted.length).toBe(1);
    });

    expect(fakeClient.callTool).toHaveBeenCalledWith({ name: 'get_status', arguments: { verbose: true } });
    const response = harness.posted[0] as { ok: boolean; result: unknown };
    expect(response.ok).toBe(true);
    expect(serializeToolResult(response.result)).toBe('pong');
    stop();
  });

  it('非约定端口名与非法消息被忽略', () => {
    const harness = createHarness();
    const stop = startPageToolsBridge(fakeClient);
    harness.connectAs('other-port');

    harness.dispatch({ id: 3, type: 'unknown' });
    harness.dispatch('garbage');

    expect(harness.posted).toHaveLength(0);
    stop();
  });

  it('stop 后移除监听器并断开活跃端口', () => {
    const harness = createHarness();
    const stop = startPageToolsBridge(fakeClient);
    harness.connect();
    stop();
    // 再次派发不应产生任何响应
    harness.dispatch({ id: 4, type: 'listTools' });
    expect(harness.posted).toHaveLength(0);
  });
});
