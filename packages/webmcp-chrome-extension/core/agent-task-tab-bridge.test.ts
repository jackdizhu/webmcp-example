// agent-task-tab-bridge 单测：init-request 同路转发（C6 F4）+ F5 孤儿修复（C7 Q6）
// + 失联补偿回归（既有语义）。window 与 chrome.runtime 均为手工 stub（node 环境）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TASK_TAB_PORT_NAME, isAgentTaskTabMessage } from './agent-task-protocol';
import { startAgentTaskTabBridge } from './agent-task-tab-bridge';

const SDK_SOURCE = 'webmcp-agent-task-sdk';
const BRIDGE_SOURCE = 'webmcp-agent-task-bridge';

/** 桥接测试桩：伪造 window（message 监听/postMessage）与 chrome.runtime（connect/Port）。 */
function createHarness() {
  type WindowMessageListener = (event: { source: unknown; data: unknown }) => void;
  const windowListeners = new Set<WindowMessageListener>();
  const removedWindowListeners = new Set<WindowMessageListener>();
  /** 桥接 postToPage 的输出（window.postMessage）。 */
  const pagePosted: Array<Record<string, unknown>> = [];

  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (_type: string, listener: WindowMessageListener) => {
      windowListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: WindowMessageListener) => {
      windowListeners.delete(listener);
      removedWindowListeners.add(listener);
    },
    postMessage: (message: unknown) => {
      pagePosted.push(message as Record<string, unknown>);
    },
  };

  const portMessageListeners: Array<(message: unknown) => void> = [];
  const portDisconnectListeners: Array<() => void> = [];
  const forwarded: unknown[] = [];
  const fakePort = {
    name: AGENT_TASK_TAB_PORT_NAME,
    postMessage: (message: unknown) => {
      forwarded.push(message);
    },
    disconnect: vi.fn(),
    onMessage: {
      addListener: (listener: (message: unknown) => void) => {
        portMessageListeners.push(listener);
      },
      removeListener: () => {},
    },
    onDisconnect: {
      addListener: (listener: () => void) => {
        portDisconnectListeners.push(listener);
      },
      removeListener: () => {},
    },
  };

  /** connect 行为可运行时切换（正常返回 Port / 抛指定异常）。 */
  const connectBehavior: { error: Error | null } = { error: null };
  const connect = vi.fn(() => {
    if (connectBehavior.error) throw connectBehavior.error;
    return fakePort;
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { connect },
  };

  /** 模拟 MAIN world SDK 的 window.postMessage（event.source = window）。 */
  const dispatchFromSdk = (message: unknown): void => {
    for (const listener of windowListeners) {
      listener({ source: (globalThis as unknown as { window: unknown }).window, data: message });
    }
  };

  /** 模拟 SW/宿主经 Port 的下行应答。 */
  const dispatchFromPort = (message: unknown): void => {
    for (const listener of portMessageListeners) listener(message);
  };

  /** 模拟 Port 断开（SW 休眠/重载/扩展 reload）。 */
  const disconnectPort = (): void => {
    for (const listener of portDisconnectListeners) listener();
  };

  return { connect, connectBehavior, forwarded, pagePosted, dispatchFromSdk, dispatchFromPort, disconnectPort, removedWindowListeners };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.clearAllMocks();
});

describe('init-request 同路转发（C6 F4）', () => {
  it('init-request 转发到 SW Port（去 source 标记）并进入 pending（建心跳连接）', () => {
    const harness = createHarness();
    const bridge = startAgentTaskTabBridge();

    harness.dispatchFromSdk({ source: SDK_SOURCE, type: 'init-request', requestId: 'r1' });

    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.forwarded).toEqual([{ type: 'init-request', requestId: 'r1' }]);
    bridge.stop();
  });

  it('init-data 应答回投页面（带 bridge source 标记）', () => {
    const harness = createHarness();
    const bridge = startAgentTaskTabBridge();
    harness.dispatchFromSdk({ source: SDK_SOURCE, type: 'init-request', requestId: 'r1' });

    const payload = { version: 1, pushedAt: 1, currentAgent: null, agents: [], a2aAgents: [], skills: [], tools: [] };
    harness.dispatchFromPort({ type: 'init-data', requestId: 'r1', payload });

    expect(harness.pagePosted).toEqual([
      { source: BRIDGE_SOURCE, type: 'init-data', requestId: 'r1', payload },
    ]);
    bridge.stop();
  });

  it('Port 断开：在途 init-request 收到 task-error(EXTENSION_HOST_UNAVAILABLE)（失联补偿覆盖拉取）', () => {
    const harness = createHarness();
    const bridge = startAgentTaskTabBridge();
    harness.dispatchFromSdk({ source: SDK_SOURCE, type: 'init-request', requestId: 'r2' });

    harness.disconnectPort();

    expect(harness.pagePosted).toEqual([
      {
        source: BRIDGE_SOURCE,
        type: 'task-error',
        requestId: 'r2',
        code: 'EXTENSION_HOST_UNAVAILABLE',
        message: expect.any(String),
      },
    ]);
    bridge.stop();
  });

  it('create-task 回归：转发与 pending 语义不受 init 分支影响', () => {
    const harness = createHarness();
    const bridge = startAgentTaskTabBridge();

    harness.dispatchFromSdk({ source: SDK_SOURCE, type: 'create-task', requestId: 't1', payload: {} });
    expect(harness.forwarded).toEqual([{ type: 'create-task', requestId: 't1', payload: {} }]);

    // ack 回投且不释放（受理回执语义保持）
    harness.dispatchFromPort({ type: 'task-ack', requestId: 't1', taskId: 'k', sessionId: 's' });
    expect(harness.pagePosted).toEqual([
      { source: BRIDGE_SOURCE, type: 'task-ack', requestId: 't1', taskId: 'k', sessionId: 's' },
    ]);
    bridge.stop();
  });
});

describe('F5 孤儿修复（扩展 reload 后旧 CS 上下文已死）', () => {
  it('runtime.connect 抛 invalidated：当前请求收到 task-error、window 监听被自摘除', () => {
    const harness = createHarness();
    const bridge = startAgentTaskTabBridge();
    // 先成功建连一次并断开（模拟在途请求），再切换 connect 抛 invalidated（模拟 reload 后孤儿）
    harness.dispatchFromSdk({ source: SDK_SOURCE, type: 'create-task', requestId: 't1', payload: {} });
    harness.disconnectPort();
    harness.pagePosted.length = 0;
    harness.connectBehavior.error = new Error('Extension context invalidated.');

    expect(() =>
      harness.dispatchFromSdk({ source: SDK_SOURCE, type: 'init-request', requestId: 'r3' })
    ).not.toThrow();

    // 当前请求 + 在途请求均落定（failPending 补偿），不悬挂
    const errors = harness.pagePosted.filter((m) => m['type'] === 'task-error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.every((m) => m['code'] === 'EXTENSION_HOST_UNAVAILABLE')).toBe(true);
    // 孤儿自摘除：window message 监听被移除，后续请求不再经此桥接（防双应答）
    expect(harness.removedWindowListeners.size).toBe(1);
    bridge.stop();
  });

  it('非 invalidated 异常：当前请求兜底回 task-error，监听保留（瞬时错误可重试）', () => {
    const harness = createHarness();
    const bridge = startAgentTaskTabBridge();
    harness.connectBehavior.error = new Error('port closed');

    expect(() =>
      harness.dispatchFromSdk({ source: SDK_SOURCE, type: 'init-request', requestId: 'r4' })
    ).not.toThrow();

    expect(harness.pagePosted).toEqual([
      {
        source: BRIDGE_SOURCE,
        type: 'task-error',
        requestId: 'r4',
        code: 'EXTENSION_HOST_UNAVAILABLE',
        message: expect.any(String),
      },
    ]);
    expect(harness.removedWindowListeners.size).toBe(0);
    bridge.stop();
  });
});

describe('守卫与协议对齐', () => {
  it('SDK 消息经 isAgentTaskTabMessage 校验（init-request 已入联合）', () => {
    expect(isAgentTaskTabMessage({ type: 'init-request', requestId: 'r1' })).toBe(true);
  });

  it('非 SDK source 的窗口消息被忽略', () => {
    const harness = createHarness();
    const bridge = startAgentTaskTabBridge();
    harness.dispatchFromSdk({ source: 'other', type: 'init-request', requestId: 'r5' });
    expect(harness.connect).not.toHaveBeenCalled();
    bridge.stop();
  });
});
