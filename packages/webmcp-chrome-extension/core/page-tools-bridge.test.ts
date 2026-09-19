import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAGE_TOOLS_PORT_NAME,
  serializeToolResult,
  startPageToolsBridge,
} from './page-tools-bridge';

/** 桥接测试桩：伪造 chrome.runtime.onConnect 与 Port 行为（支持多条 Port 与手动断开）。 */
function createHarness() {
  type ConnectListener = (port: unknown) => void;
  const connectListeners = new Set<ConnectListener>();

  const posted: unknown[] = [];
  const ports: Array<{ dispatch: (message: unknown) => void; fireDisconnect: () => void }> = [];

  const makePort = (name: string) => {
    type MessageListener = (message: unknown) => void;
    let messageListener: MessageListener | null = null;
    let disconnectListener: (() => void) | null = null;
    const port = {
      name,
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
        addListener: (listener: () => void) => {
          disconnectListener = listener;
        },
        removeListener: () => {
          disconnectListener = null;
        },
      },
      dispatch: (message: unknown) => {
        messageListener?.(message);
      },
      fireDisconnect: () => {
        disconnectListener?.();
      },
    };
    ports.push(port);
    return port;
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
    for (const listener of connectListeners) listener(makePort(PAGE_TOOLS_PORT_NAME));
  };

  /** 以自定义端口名模拟其他扩展上下文接入。 */
  const connectAs = (name: string): void => {
    for (const listener of connectListeners) listener(makePort(name));
  };

  const dispatch = (message: unknown): void => {
    ports[0]?.dispatch(message);
  };

  return { posted, ports, connect, connectAs, dispatch };
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
    const bridge = startPageToolsBridge(fakeClient);
    harness.connect();

    harness.dispatch({ id: 1, type: 'listTools' });
    await vi.waitFor(() => {
      expect(harness.posted.length).toBe(1);
    });

    const response = harness.posted[0] as { id: number; ok: boolean; result: Array<{ name: string }> };
    expect(response.id).toBe(1);
    expect(response.ok).toBe(true);
    expect(response.result[0]?.name).toBe('get_status');
    bridge.stop();
  });

  it('callTool 请求把 name 与 args 透传给 MCP Client', async () => {
    const harness = createHarness();
    const bridge = startPageToolsBridge(fakeClient);
    harness.connect();

    harness.dispatch({ id: 2, type: 'callTool', name: 'get_status', args: { verbose: true } });
    await vi.waitFor(() => {
      expect(harness.posted.length).toBe(1);
    });

    expect(fakeClient.callTool).toHaveBeenCalledWith({ name: 'get_status', arguments: { verbose: true } });
    const response = harness.posted[0] as { ok: boolean; result: unknown };
    expect(response.ok).toBe(true);
    expect(serializeToolResult(response.result)).toBe('pong');
    bridge.stop();
  });

  it('非约定端口名与非法消息被忽略', () => {
    const harness = createHarness();
    const bridge = startPageToolsBridge(fakeClient);
    harness.connectAs('other-port');

    harness.dispatch({ id: 3, type: 'unknown' });
    harness.dispatch('garbage');

    expect(harness.posted).toHaveLength(0);
    bridge.stop();
  });

  it('stop 后移除监听器并断开活跃端口', () => {
    const harness = createHarness();
    const bridge = startPageToolsBridge(fakeClient);
    harness.connect();
    bridge.stop();
    // 再次派发不应产生任何响应
    harness.dispatch({ id: 4, type: 'listTools' });
    expect(harness.posted).toHaveLength(0);
  });

  it('notifyToolsChanged 向所有活跃端口广播通知，stop 后不再广播', () => {
    const harness = createHarness();
    const bridge = startPageToolsBridge(fakeClient);
    harness.connect();

    bridge.notifyToolsChanged();
    expect(harness.posted).toEqual([{ type: 'toolsChanged' }]);

    bridge.stop();
    bridge.notifyToolsChanged();
    expect(harness.posted).toHaveLength(1);
  });

  it('onAllPortsDisconnected：最后一条 Port 断开才触发（C7 自检路径触发源）', () => {
    const harness = createHarness();
    let fired = 0;
    const bridge = startPageToolsBridge(fakeClient, {
      onAllPortsDisconnected: () => {
        fired += 1;
      },
    });
    harness.connect();
    harness.connect();
    harness.ports[0]?.fireDisconnect();
    expect(fired).toBe(0);
    harness.ports[1]?.fireDisconnect();
    expect(fired).toBe(1);
    bridge.stop();
  });

  it('stop() 主动断开端口不触发 onAllPortsDisconnected（非面板关闭信号）', () => {
    const harness = createHarness();
    let fired = 0;
    const bridge = startPageToolsBridge(fakeClient, {
      onAllPortsDisconnected: () => {
        fired += 1;
      },
    });
    harness.connect();
    bridge.stop();
    expect(fired).toBe(0);
  });
});
