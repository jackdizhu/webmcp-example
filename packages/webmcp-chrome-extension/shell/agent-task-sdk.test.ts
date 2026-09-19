// agent-task-sdk 单测（C6 F3/T7）：asyncAgentInitialization 落定与超时 + asyncCreateAgentTask 回归。
// window 为手工 stub（node 环境）；SDK 只依赖 window.postMessage / addEventListener。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_INITIALIZATION_TIMEOUT_MS, installAgentTaskSdk } from './agent-task-sdk';

const SDK_SOURCE = 'webmcp-agent-task-sdk';
const BRIDGE_SOURCE = 'webmcp-agent-task-bridge';

function createHarness() {
  type MessageListener = (event: { source: unknown; data: unknown }) => void;
  const messageListeners = new Set<MessageListener>();
  /** SDK 发出的 window.postMessage（桥接侧入口）。 */
  const sent: Array<Record<string, unknown>> = [];

  const windowStub = {
    addEventListener: (_type: string, listener: MessageListener) => {
      messageListeners.add(listener);
    },
    postMessage: (message: unknown) => {
      sent.push(message as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { window: unknown }).window = windowStub;

  installAgentTaskSdk();
  const sdk = (windowStub as { webmcpAgent?: { asyncCreateAgentTask: (...args: unknown[]) => unknown; asyncAgentInitialization: (...args: unknown[]) => unknown } }).webmcpAgent!;
  if (!sdk) throw new Error('SDK 未挂载');

  /** 模拟 CS 桥接的下行应答（event.source = window）。 */
  const dispatchFromBridge = (message: unknown): void => {
    for (const listener of messageListeners) {
      listener({ source: windowStub, data: { source: BRIDGE_SOURCE, ...((message as Record<string, unknown>) ?? {}) } });
    }
  };

  return { sdk, sent, dispatchFromBridge };
}

const INIT_PAYLOAD = {
  version: 1,
  pushedAt: 1000,
  currentAgent: null,
  agents: [],
  a2aAgents: [],
  skills: [],
  tools: [],
};

beforeEach(() => {
  delete (globalThis as unknown as { webmcpAgent?: unknown }).webmcpAgent;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe('asyncAgentInitialization（C6 R4/Q11-Q12）', () => {
  it('init-data 应答 resolve 载荷；请求无 structuredClone 预检直接发出', async () => {
    const { sdk, sent, dispatchFromBridge } = createHarness();

    const promise = sdk.asyncAgentInitialization();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: SDK_SOURCE, type: 'init-request' });
    expect(typeof (sent[0] as { requestId?: string }).requestId).toBe('string');

    const requestId = (sent[0] as { requestId: string }).requestId;
    dispatchFromBridge({ type: 'init-data', requestId, payload: INIT_PAYLOAD });
    await expect(promise).resolves.toEqual(INIT_PAYLOAD);
  });

  it('10s 兜底超时 → reject TASK_TIMED_OUT（fake timers）', async () => {
    vi.useFakeTimers();
    const { sdk } = createHarness();

    const promise = sdk.asyncAgentInitialization();
    const expectation = expect(promise).rejects.toMatchObject({ code: 'TASK_TIMED_OUT' });
    await vi.advanceTimersByTimeAsync(AGENT_INITIALIZATION_TIMEOUT_MS + 1);
    await expectation;
  });

  it('超时前落定则定时器不再触发（先 init-data 后 advance 无第二次落定）', async () => {
    vi.useFakeTimers();
    const { sdk, sent, dispatchFromBridge } = createHarness();

    const promise = sdk.asyncAgentInitialization();
    const requestId = (sent[0] as { requestId: string }).requestId;
    dispatchFromBridge({ type: 'init-data', requestId, payload: INIT_PAYLOAD });
    await expect(promise).resolves.toEqual(INIT_PAYLOAD);

    await vi.advanceTimersByTimeAsync(AGENT_INITIALIZATION_TIMEOUT_MS + 1);
    expect(sent).toHaveLength(1); // 无多余请求，无未处理 reject
  });

  it('task-error → reject（失联补偿路径覆盖拉取）', async () => {
    const { sdk, sent, dispatchFromBridge } = createHarness();

    const promise = sdk.asyncAgentInitialization();
    const requestId = (sent[0] as { requestId: string }).requestId;
    dispatchFromBridge({ type: 'task-error', requestId, code: 'EXTENSION_HOST_UNAVAILABLE', message: 'x' });
    await expect(promise).rejects.toMatchObject({ code: 'EXTENSION_HOST_UNAVAILABLE' });
  });
});

describe('asyncCreateAgentTask 回归', () => {
  it('task-done → resolve 终态载荷（语义不受 init 扩展影响）', async () => {
    const { sdk, sent, dispatchFromBridge } = createHarness();

    const promise = sdk.asyncCreateAgentTask({ taskType: 'agent', agentName: '通用智能体', agentPrompt: 'p' });
    const requestId = (sent[0] as { requestId: string }).requestId;
    dispatchFromBridge({
      type: 'task-done',
      requestId,
      taskId: 't1',
      sessionId: 's1',
      status: 'completed',
      result: 'ok',
    });
    await expect(promise).resolves.toEqual({ taskId: 't1', sessionId: 's1', status: 'completed', result: 'ok' });
  });
});
