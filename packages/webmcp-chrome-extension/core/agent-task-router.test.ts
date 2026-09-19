// agent-task-router 单测（C6 F5/T3 + C7 P3/T5 部分）：init-request 闸门与转发、
// init-data 应答路由、宿主关闭广播（guard 语义）、host-status-query 查询应答。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TASK_HOST_PORT_NAME,
  AGENT_TASK_TAB_PORT_NAME,
  TAB_INVOKE_ALLOWLIST_KEY,
} from './agent-task-protocol';
import { startAgentTaskRouter, type AgentTaskRouterDeps } from './agent-task-router';

type PortListener = (message: unknown) => void;
type DisconnectListener = () => void;

interface FakePort {
  name: string;
  sender?: { tab?: { id: number }; origin?: string };
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener(l: PortListener): void; removeListener(l: PortListener): void };
  onDisconnect: { addListener(l: DisconnectListener): void; removeListener(l: DisconnectListener): void };
  /** 测试侧捕获：路由注册的监听（_ml = message、_dl = disconnect）。 */
  fire: { message(m: unknown): void; disconnect(): void };
}

/** 路由测试桩：伪造 chrome.runtime（onConnect/onMessage/storage）与 chrome.tabs.sendMessage。 */
function createHarness(deps: AgentTaskRouterDeps = {}) {
  const connectListeners = new Set<(port: FakePort) => void>();
  const runtimeMessageListeners = new Set<
    (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean
  >();
  const tabMessages: Array<{ tabId: number; message: unknown }> = [];

  const makePort = (name: string, sender?: FakePort['sender']): FakePort => {
    let messageListener: PortListener | null = null;
    let disconnectListener: DisconnectListener | null = null;
    const port: FakePort = {
      name,
      // exactOptionalPropertyTypes：undefined 不可显式赋给可选属性，条件展开
      ...(sender !== undefined ? { sender } : {}),
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: {
        addListener: (l) => {
          messageListener = l;
        },
        removeListener: () => {
          messageListener = null;
        },
      },
      onDisconnect: {
        addListener: (l) => {
          disconnectListener = l;
        },
        removeListener: () => {
          disconnectListener = null;
        },
      },
      fire: {
        message: (m) => messageListener?.(m),
        disconnect: () => disconnectListener?.(),
      },
    };
    return port;
  };

  const makeTabPort = (tabId: number, origin: string): FakePort =>
    makePort(AGENT_TASK_TAB_PORT_NAME, { tab: { id: tabId }, origin });
  const makeHostPort = (): FakePort => makePort(AGENT_TASK_HOST_PORT_NAME);

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onConnect: {
        addListener: (l: (port: FakePort) => void) => connectListeners.add(l),
        removeListener: (l: (port: FakePort) => void) => connectListeners.delete(l),
      },
      onMessage: {
        addListener: (
          l: (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean
        ) => {
          runtimeMessageListeners.add(l);
        },
        removeListener: (
          l: (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean
        ) => {
          runtimeMessageListeners.delete(l);
        },
      },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ [TAB_INVOKE_ALLOWLIST_KEY]: ['https://app.example.com'] })),
      },
      onChanged: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    tabs: {
      sendMessage: vi.fn((tabId: number, message: unknown, callback?: () => void) => {
        tabMessages.push({ tabId, message });
        callback?.();
      }),
    },
  };

  const connect = (port: FakePort): void => {
    for (const listener of connectListeners) listener(port);
  };

  /** 触发 runtime.onMessage（CS 自检查询入口）。 */
  const dispatchRuntimeMessage = (message: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      for (const listener of runtimeMessageListeners) {
        const handled = listener(message, {}, (response) => resolve(response));
        if (!handled) resolve(undefined);
      }
    });

  const router = startAgentTaskRouter(deps);
  return { router, makeTabPort, makeHostPort, connect, tabMessages, dispatchRuntimeMessage };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.clearAllMocks();
});

describe('init-request 闸门与转发（C6 F5）', () => {
  it('白名单命中 + 宿主在线：sender 注入转发并登记，init-data 应答路由回发起页签并释放', async () => {
    const harness = createHarness();
    const tabPort = harness.makeTabPort(7, 'https://app.example.com');
    harness.connect(tabPort);
    const hostPort = harness.makeHostPort();
    harness.connect(hostPort);
    await flush();

    tabPort.fire.message({ type: 'init-request', requestId: 'r1' });

    expect(hostPort.postMessage).toHaveBeenCalledWith({
      type: 'init-request',
      requestId: 'r1',
      sender: { tabId: 7, origin: 'https://app.example.com' },
    });
    hostPort.fire.message({ type: 'init-data', requestId: 'r1', payload: { version: 1 } });
    expect(tabPort.postMessage).toHaveBeenCalledWith({ type: 'init-data', requestId: 'r1', payload: { version: 1 } });
    harness.router.stop();
  });

  it('白名单拒绝：ORIGIN_NOT_ALLOWED，不触达宿主', async () => {
    const harness = createHarness();
    const tabPort = harness.makeTabPort(7, 'https://evil.example.com');
    harness.connect(tabPort);
    const hostPort = harness.makeHostPort();
    harness.connect(hostPort);
    await flush();

    tabPort.fire.message({ type: 'init-request', requestId: 'r2' });

    expect(tabPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task-error', requestId: 'r2', code: 'ORIGIN_NOT_ALLOWED' })
    );
    expect(hostPort.postMessage).not.toHaveBeenCalled();
    harness.router.stop();
  });

  it('宿主不可用：EXTENSION_HOST_UNAVAILABLE', async () => {
    const harness = createHarness();
    const tabPort = harness.makeTabPort(7, 'https://app.example.com');
    harness.connect(tabPort);
    await flush(); // 无 hostPort 连入

    tabPort.fire.message({ type: 'init-request', requestId: 'r3' });

    expect(tabPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task-error', requestId: 'r3', code: 'EXTENSION_HOST_UNAVAILABLE' })
    );
    harness.router.stop();
  });
});

describe('宿主关闭广播（C7 P3）', () => {
  it('真断开（hostPort === port）：向 getBroadcastTabIds 返回的页签逐个广播', async () => {
    const harness = createHarness({ getBroadcastTabIds: () => [1, 2] });
    const hostPort = harness.makeHostPort();
    harness.connect(hostPort);
    await flush();

    hostPort.fire.disconnect();
    await flush();

    expect(harness.tabMessages).toHaveLength(2);
    expect(harness.tabMessages[0]?.message).toMatchObject({
      type: 'webmcp-host-status',
      status: 'unavailable',
    });
    expect(typeof (harness.tabMessages[0]?.message as { occurredAt?: number }).occurredAt).toBe('number');
    harness.router.stop();
  });

  it('后连替换（新宿主先连入，旧 Port 断开事件后到）：不广播', async () => {
    const harness = createHarness({ getBroadcastTabIds: () => [1, 2] });
    const oldHost = harness.makeHostPort();
    harness.connect(oldHost);
    const newHost = harness.makeHostPort();
    harness.connect(newHost); // 替换：hostPort = newHost
    await flush();

    oldHost.fire.disconnect();
    await flush();

    expect(harness.tabMessages).toHaveLength(0);
    harness.router.stop();
  });

  it('未注入 getBroadcastTabIds：真断开不广播但在途请求补偿照常（failAllInFlight 保持 guard 外）', async () => {
    const harness = createHarness();
    const tabPort = harness.makeTabPort(7, 'https://app.example.com');
    harness.connect(tabPort);
    const hostPort = harness.makeHostPort();
    harness.connect(hostPort);
    await flush();
    tabPort.fire.message({ type: 'init-request', requestId: 'r9' });

    hostPort.fire.disconnect();

    expect(harness.tabMessages).toHaveLength(0);
    expect(tabPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task-error', requestId: 'r9', code: 'EXTENSION_HOST_UNAVAILABLE' })
    );
    harness.router.stop();
  });
});

describe('host-status-query 查询应答（C7 自检）', () => {
  it('isSidePanelAlive=false → reply hostAlive:false', async () => {
    const harness = createHarness({ isSidePanelAlive: async () => false });
    const reply = await harness.dispatchRuntimeMessage({ type: 'host-status-query' });
    expect(reply).toEqual({ type: 'host-status-reply', hostAlive: false });
    harness.router.stop();
  });

  it('探测异常 → 从严 reply hostAlive:true（宁可漏报不误报）', async () => {
    const harness = createHarness({
      isSidePanelAlive: async () => {
        throw new Error('getContexts failed');
      },
    });
    const reply = await harness.dispatchRuntimeMessage({ type: 'host-status-query' });
    expect(reply).toEqual({ type: 'host-status-reply', hostAlive: true });
    harness.router.stop();
  });

  it('非查询消息不处理', async () => {
    const harness = createHarness({ isSidePanelAlive: async () => false });
    const reply = await harness.dispatchRuntimeMessage({ type: 'other' });
    expect(reply).toBeUndefined();
    harness.router.stop();
  });
});
