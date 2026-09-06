import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_TOOLS_PORT_NAME } from './page-tools-bridge';
import type { RelayConnectionStatus, RelayToolsFacade } from './relay-source-client';
import { RELAY_STATUS_PORT_NAME } from './relay-status-protocol';
import {
  startRelayStatusPort,
  startTabSourceManager,
  type ManagedTabSource,
  type TabsApi,
} from './tab-source-manager';

/** 构造一条连接状态快照（updatedAt 固定，便于快照相等断言）。 */
function makeStatus(patch: Partial<RelayConnectionStatus> = {}): RelayConnectionStatus {
  return {
    state: 'connected',
    endpoint: { host: '127.0.0.1', port: 9333 },
    toolsCount: 2,
    updatedAt: 1_700_000_000_000,
    ...patch,
  };
}

/** 测试桩 Port：伪造 chrome.runtime.Port 的收发行为。 */
class FakePort {
  sent: unknown[] = [];
  disconnected = false;
  private messageListeners = new Set<(message: unknown) => void>();
  private disconnectListeners = new Set<(port: unknown) => void>();

  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    for (const listener of this.disconnectListeners) {
      listener(this);
    }
  }

  get onMessage(): { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void } {
    return {
      addListener: (listener) => this.messageListeners.add(listener),
      removeListener: (listener) => this.messageListeners.delete(listener),
    };
  }

  get onDisconnect(): { addListener(listener: (port: unknown) => void): void; removeListener(listener: (port: unknown) => void): void } {
    return {
      addListener: (listener) => this.disconnectListeners.add(listener),
      removeListener: (listener) => this.disconnectListeners.delete(listener),
    };
  }

  /** 模拟 content script 侧回包/通知。 */
  receive(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }
}

/** 测试桩 chrome.tabs API 面。 */
function createTabsStub(): TabsApi & {
  tabs: Map<number, { id: number; url?: string; title?: string }>;
  ports: FakePort[];
  emitUpdated(tabId: number, changeInfo: { status?: string; url?: string }, tab: { id?: number; url?: string; title?: string }): void;
  emitRemoved(tabId: number): void;
} {
  const tabs = new Map<number, { id: number; url?: string; title?: string }>();
  const ports: FakePort[] = [];
  const updatedListeners = new Set<TabsApi['onUpdated'] extends { addListener(cb: infer C): void } ? C : never>();
  const removedListeners = new Set<(tabId: number) => void>();

  return {
    tabs,
    ports,
    emitUpdated: (tabId, changeInfo, tab) => {
      for (const listener of updatedListeners) {
        listener(tabId, changeInfo, tab);
      }
    },
    emitRemoved: (tabId) => {
      for (const listener of removedListeners) {
        listener(tabId);
      }
    },
    get: async (tabId) => tabs.get(tabId) ?? { id: tabId },
    query: async () => [...tabs.values()],
    connect: (_tabId) => {
      const port = new FakePort(PAGE_TOOLS_PORT_NAME);
      ports.push(port);
      return port as unknown as chrome.runtime.Port;
    },
    reload: vi.fn(async () => undefined),
    onUpdated: {
      addListener: (listener) => updatedListeners.add(listener),
      removeListener: (listener) => updatedListeners.delete(listener),
    },
    onRemoved: {
      addListener: (listener) => removedListeners.add(listener),
      removeListener: (listener) => removedListeners.delete(listener),
    },
  };
}

/** 客户端桩：记录 start/stop/updateSource 调用并保留构造入参。 */
interface ClientStub extends ManagedTabSource {
  input: { tabId: number; source: { tabId: string; origin?: string; url?: string; title?: string }; facade: RelayToolsFacade };
  /** 触发已注册状态监听器（编排层经此收到连接状态）。 */
  emitStatus(status: RelayConnectionStatus): void;
  statusListeners: Set<(status: RelayConnectionStatus) => void>;
}

type ClientFactory = NonNullable<
  NonNullable<Parameters<typeof startTabSourceManager>[0]>['clientFactory']
>;

function createClientStubFactory(): {
  stubs: ClientStub[];
  factory: ClientFactory;
} {
  const stubs: ClientStub[] = [];
  const factory: ClientFactory = (input): ManagedTabSource => {
    const statusListeners = new Set<(status: RelayConnectionStatus) => void>();
    const stub: ClientStub = {
      input,
      start: vi.fn(),
      stop: vi.fn(),
      updateSource: vi.fn(),
      statusListeners,
      emitStatus: (status) => {
        for (const listener of statusListeners) {
          listener(status);
        }
      },
      onStatus: (listener) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
    };
    stubs.push(stub);
    return stub;
  };
  return { stubs, factory };
}

/** 内存端点缓存。 */
function createMemoryCache() {
  let value: { host: string; port: number } | null = null;
  return {
    read: async () => value,
    write: async (endpoint: { host: string; port: number }) => {
      value = endpoint;
    },
    clear: async () => {
      value = null;
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('startTabSourceManager', () => {
  it('启动时重扫已打开的 http(s) 标签页并逐 tab 创建源客户端', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/page', title: 'A' });
    tabsStub.tabs.set(2, { id: 2, url: 'chrome://version', title: 'Chrome' });
    const { stubs, factory } = createClientStubFactory();

    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    await vi.waitFor(() => {
      expect(stubs).toHaveLength(1);
    });
    expect(stubs[0]!.input.tabId).toBe(1);
    expect(stubs[0]!.input.source).toEqual({
      tabId: '1',
      origin: 'https://a.com',
      url: 'https://a.com/page',
      title: 'A',
    });
    expect(stubs[0]!.start).toHaveBeenCalled();
    manager.stop();
  });

  it('recordInvokeLog 写入环形缓冲并通知监听器（started 追加 / finished 合并）', async () => {
    const tabsStub = createTabsStub();
    const { factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    const events: Array<{ phase: string; entry: { callId: string; ok?: boolean } }> = [];
    const unsubscribe = manager.onInvokeLog((phase, entry) => {
      events.push({ phase, entry: { callId: entry.callId, ok: entry.ok } });
    });

    manager.recordInvokeLog('started', {
      callId: 'c-1',
      tabId: 7,
      toolName: 'get_status',
      startedAt: 1000,
      argsSummary: '{}',
    });
    manager.recordInvokeLog('finished', {
      callId: 'c-1',
      tabId: 7,
      toolName: 'get_status',
      startedAt: 1000,
      argsSummary: '{}',
      elapsedMs: 42,
      ok: true,
      resultSummary: '{"ok":1}',
    });

    expect(events).toEqual([
      { phase: 'started', entry: { callId: 'c-1', ok: undefined } },
      { phase: 'finished', entry: { callId: 'c-1', ok: true } },
    ]);
    const logs = manager.getInvokeLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ callId: 'c-1', ok: true, elapsedMs: 42, tabId: 7 });
    unsubscribe();

    // 取消订阅后不再通知，但缓冲继续累积
    manager.recordInvokeLog('started', {
      callId: 'c-2',
      tabId: 7,
      toolName: 'echo',
      startedAt: 2000,
      argsSummary: '{}',
    });
    expect(events).toHaveLength(2);
    expect(manager.getInvokeLogs()).toHaveLength(2);
    manager.stop();
  });

  it('标签页导航完成后创建源，端口走 page-tools 桥接协议', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(
      7,
      { status: 'complete' },
      { id: 7, url: 'https://b.com/', title: 'B' }
    );

    await vi.waitFor(() => {
      expect(stubs).toHaveLength(1);
    });
    expect(stubs[0]!.input.source).toMatchObject({ tabId: '7', origin: 'https://b.com', title: 'B' });
    expect(tabsStub.ports).toHaveLength(1);
    expect(tabsStub.ports[0]!.name).toBe(PAGE_TOOLS_PORT_NAME);

    // 门面 listTools → page-tools 协议请求；content script 回包后 resolve
    const toolsPromise = stubs[0]!.input.facade.listTools();
    const request = tabsStub.ports[0]!.sent[0] as { id: number; type: string };
    expect(request.type).toBe('listTools');
    tabsStub.ports[0]!.receive({
      id: request.id,
      ok: true,
      result: [{ name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } }],
    });
    await expect(toolsPromise).resolves.toEqual([
      { name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } },
    ]);
    manager.stop();
  });

  it('callTool 经桥接协议转发并回传结果', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(9, { status: 'complete' }, { id: 9, url: 'https://c.com/', title: 'C' });
    await vi.waitFor(() => expect(stubs).toHaveLength(1));

    const callPromise = stubs[0]!.input.facade.callTool('get_status', { a: 1 });
    const request = tabsStub.ports[0]!.sent[0] as { id: number; type: string; name?: string; args?: unknown };
    expect(request).toMatchObject({ type: 'callTool', name: 'get_status', args: { a: 1 } });
    tabsStub.ports[0]!.receive({ id: request.id, ok: true, result: { content: [] } });
    await expect(callPromise).resolves.toEqual({ content: [] });
    manager.stop();
  });

  it('toolsChanged 桥接通知到达门面监听器', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(5, { status: 'complete' }, { id: 5, url: 'https://d.com/', title: 'D' });
    await vi.waitFor(() => expect(stubs).toHaveLength(1));

    const listener = vi.fn();
    stubs[0]!.input.facade.onToolsChanged(listener);
    tabsStub.ports[0]!.receive({ type: 'toolsChanged' });
    expect(listener).toHaveBeenCalled();
    manager.stop();
  });

  it('同一标签页重复导航完成只更新元数据，不重建客户端', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(3, { status: 'complete' }, { id: 3, url: 'https://e.com/', title: 'E1' });
    await vi.waitFor(() => expect(stubs).toHaveLength(1));
    tabsStub.emitUpdated(3, { status: 'complete' }, { id: 3, url: 'https://e.com/v2', title: 'E2' });
    await vi.waitFor(() => {
      expect(stubs[0]!.updateSource).toHaveBeenCalledWith({ url: 'https://e.com/v2', title: 'E2', origin: 'https://e.com' });
    });
    expect(stubs).toHaveLength(1);
    manager.stop();
  });

  it('导航到非 http(s) 页面或标签页关闭时释放客户端与端口', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(11, { status: 'complete' }, { id: 11, url: 'https://f.com/', title: 'F' });
    await vi.waitFor(() => expect(stubs).toHaveLength(1));

    // 导航到 chrome:// 页面 → 释放
    tabsStub.emitUpdated(11, { status: 'complete', url: 'chrome://settings' }, { id: 11, url: 'chrome://settings' });
    await vi.waitFor(() => {
      expect(stubs[0]!.stop).toHaveBeenCalled();
      expect(tabsStub.ports[0]!.disconnected).toBe(true);
    });

    // 再导航回 http(s) → 新客户端
    tabsStub.emitUpdated(11, { status: 'complete', url: 'https://g.com/' }, { id: 11, url: 'https://g.com/', title: 'G' });
    await vi.waitFor(() => expect(stubs).toHaveLength(2));

    // 标签页关闭 → 释放
    tabsStub.emitRemoved(11);
    await vi.waitFor(() => {
      expect(stubs[1]!.stop).toHaveBeenCalled();
      expect(tabsStub.ports[1]!.disconnected).toBe(true);
    });
    manager.stop();
  });

  it('stop() 释放全部客户端且不再响应事件', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(21, { status: 'complete' }, { id: 21, url: 'https://h.com/', title: 'H' });
    await vi.waitFor(() => expect(stubs).toHaveLength(1));

    manager.stop();
    expect(stubs[0]!.stop).toHaveBeenCalled();

    // stop 后再导航 → 不创建新客户端
    tabsStub.emitUpdated(22, { status: 'complete' }, { id: 22, url: 'https://i.com/', title: 'I' });
    expect(stubs).toHaveLength(1);
  });

  it('客户端状态回调聚合为带 tabId/页面元数据的状态快照', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(31, { status: 'complete' }, { id: 31, url: 'https://j.com/', title: 'J' });
    await vi.waitFor(() => expect(stubs).toHaveLength(1));

    const listener = vi.fn();
    manager.onStatusChange(listener);

    stubs[0]!.emitStatus(makeStatus({ state: 'connecting' }));
    stubs[0]!.emitStatus(makeStatus({ state: 'connected', toolsCount: 3 }));

    await vi.waitFor(() => {
      const statuses = manager.getStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({
        tabId: 31,
        state: 'connected',
        toolsCount: 3,
        url: 'https://j.com/',
        title: 'J',
      });
    });
    // onStatusChange 订阅即收到一次快照 + 之后每次变更推送
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
    manager.stop();
  });

  it('标签页释放后状态条目同步移除并推送快照', async () => {
    const tabsStub = createTabsStub();
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.emitUpdated(41, { status: 'complete' }, { id: 41, url: 'https://k.com/', title: 'K' });
    await vi.waitFor(() => expect(stubs).toHaveLength(1));
    stubs[0]!.emitStatus(makeStatus());
    expect(manager.getStatuses()).toHaveLength(1);

    tabsStub.emitRemoved(41);
    await vi.waitFor(() => {
      expect(manager.getStatuses()).toHaveLength(0);
    });
    manager.stop();
  });
  it('Port 意外断连（Receiving end does not exist）时重注入 content scripts 并重建客户端', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('chrome', {
        runtime: { lastError: { message: 'Could not establish connection. Receiving end does not exist.' } },
      });
      const tabsStub = createTabsStub();
      tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
      const { stubs, factory } = createClientStubFactory();
      const reinject = vi.fn(async () => undefined);
      const manager = startTabSourceManager({
        tabsApi: tabsStub,
        clientFactory: factory,
        endpointCache: createMemoryCache(),
        reinjectContentScripts: reinject,
      });

      await vi.waitFor(() => {
        expect(stubs).toHaveLength(1);
      });
      // 模拟页面侧无接收方导致的意外断连（disposeClient 之外自发发生）
      tabsStub.ports[0]!.disconnect();

      // 首次自愈退避 1s：先重注入，再 dispose + 重建客户端
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(stubs).toHaveLength(2);
      });
      expect(reinject).toHaveBeenCalledWith(1);
      expect(stubs[1]!.input.tabId).toBe(1);
      expect(stubs[1]!.start).toHaveBeenCalled();
      expect(tabsStub.ports).toHaveLength(2);
      manager.stop();
    } finally {
      vi.unstubAllGlobals();
      if (vi.isFakeTimers()) {
        vi.useRealTimers();
      }
    }
  });

  it('编排层主动断开（导航过滤/标签页移除）不触发自愈', async () => {
    vi.useFakeTimers();
    try {
      const tabsStub = createTabsStub();
      tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
      const { stubs, factory } = createClientStubFactory();
      const reinject = vi.fn(async () => undefined);
      const manager = startTabSourceManager({
        tabsApi: tabsStub,
        clientFactory: factory,
        endpointCache: createMemoryCache(),
        reinjectContentScripts: reinject,
      });

      await vi.waitFor(() => {
        expect(stubs).toHaveLength(1);
      });
      // 标签页移除 → disposeClient 主动断开 Port（intentional）
      tabsStub.emitRemoved(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stubs).toHaveLength(1);
      expect(reinject).not.toHaveBeenCalled();
      manager.stop();
    } finally {
      if (vi.isFakeTimers()) {
        vi.useRealTimers();
      }
    }
  });

  it('导航完成重置自愈退避：新页面 Port 再次断连仍以 1s 首次延迟自愈', async () => {
    vi.useFakeTimers();
    try {
      const tabsStub = createTabsStub();
      const { stubs, factory } = createClientStubFactory();
      const reinject = vi.fn(async () => undefined);
      const manager = startTabSourceManager({
        tabsApi: tabsStub,
        clientFactory: factory,
        endpointCache: createMemoryCache(),
        reinjectContentScripts: reinject,
      });

      // 第一次导航：建立客户端 → 意外断连 → 自愈重建（attempt=1，下次退避 2s）
      tabsStub.emitUpdated(1, { status: 'complete' }, { id: 1, url: 'https://a.com/', title: 'A' });
      await vi.waitFor(() => {
        expect(stubs).toHaveLength(1);
      });
      tabsStub.ports[0]!.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(stubs).toHaveLength(2);
      });

      // 新一次导航完成 → 退避计数重置 → 再断连应仍以 1s 自愈而非 2s
      tabsStub.emitUpdated(1, { status: 'complete' }, { id: 1, url: 'https://a.com/v2', title: 'A2' });
      tabsStub.ports[1]!.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(stubs).toHaveLength(3);
      });
      manager.stop();
    } finally {
      if (vi.isFakeTimers()) {
        vi.useRealTimers();
      }
    }
  });
});

describe('startRelayStatusPort', () => {
  /** 状态端口桩：模拟 SW 侧 chrome.runtime.onConnect。 */
  function createRuntimeStub(): {
    onConnect: {
      addListener(cb: (port: chrome.runtime.Port) => void): void;
      removeListener(cb: (port: chrome.runtime.Port) => void): void;
    };
    /** 模拟侧边栏发起连接，返回服务端视角的 Port（FakePort）。 */
    emitConnect(name: string): FakePort;
  } {
    const listeners = new Set<(port: chrome.runtime.Port) => void>();
    return {
      onConnect: {
        addListener: (cb) => listeners.add(cb),
        removeListener: (cb) => listeners.delete(cb),
      },
      emitConnect: (name) => {
        const port = new FakePort(name);
        for (const listener of listeners) {
          listener(port as unknown as chrome.runtime.Port);
        }
        return port;
      },
    };
  }

  it('连接即下发全量快照，状态变化推送更新，非约定端口名忽略', async () => {
    const runtimeStub = createRuntimeStub();
    const manager = {
      getStatuses: () => [makeStatus({ toolsCount: 1 })],
      onStatusChange: (listener: (statuses: ReturnType<typeof makeStatus>[]) => void) => {
        listener([makeStatus({ toolsCount: 2 })]);
        return () => undefined;
      },
    };
    startRelayStatusPort(manager as never, runtimeStub as never);

    // 非约定端口名 → 不收到任何消息
    const stranger = runtimeStub.emitConnect('other-port');
    expect(stranger.sent).toHaveLength(0);

    const port = runtimeStub.emitConnect(RELAY_STATUS_PORT_NAME);
    // 连接即下发全量快照
    expect(port.sent[0]).toEqual({
      type: 'snapshot',
      statuses: [makeStatus({ toolsCount: 1 })],
    });
    // onStatusChange 订阅即推送一次 update
    expect(port.sent[1]).toEqual({ type: 'update', statuses: [makeStatus({ toolsCount: 2 })] });

    // 侧边栏主动请求 → 重发快照
    port.receive({ type: 'subscribe' });
    expect(port.sent[2]).toEqual({ type: 'snapshot', statuses: [makeStatus({ toolsCount: 1 })] });
  });

  it('连接下发调用日志快照，事件推送增量，断开取消订阅', async () => {
    const runtimeStub = createRuntimeStub();
    const invokeLogListeners = new Set<
      (phase: 'started' | 'finished', entry: { callId: string }) => void
    >();
    const buffered = [{ callId: 'c-0', tabId: 1, toolName: 't', startedAt: 1, argsSummary: '{}' }];
    const manager = {
      getStatuses: () => [],
      onStatusChange: () => () => undefined,
      getInvokeLogs: () => buffered,
      onInvokeLog: (listener: (phase: 'started' | 'finished', entry: { callId: string }) => void) => {
        invokeLogListeners.add(listener);
        return () => {
          invokeLogListeners.delete(listener);
        };
      },
    };
    startRelayStatusPort(manager as never, runtimeStub as never);

    const port = runtimeStub.emitConnect(RELAY_STATUS_PORT_NAME);
    expect(port.sent[0]).toEqual({ type: 'snapshot', statuses: [] });
    expect(port.sent[1]).toEqual({ type: 'invoke-logs', entries: buffered });

    // 增量事件推送
    for (const listener of invokeLogListeners) {
      listener('started', { callId: 'c-1' });
    }
    expect(port.sent[2]).toEqual({
      type: 'invoke-log',
      phase: 'started',
      entry: { callId: 'c-1' },
    });

    // 断开后不再推送
    port.disconnect();
    expect(invokeLogListeners).toHaveLength(0);
    for (const listener of [...invokeLogListeners]) {
      listener('finished', { callId: 'c-1' });
    }
    expect(port.sent).toHaveLength(3);
  });

  it('manager 未提供调用日志接口时仅推送状态（向后兼容）', async () => {
    const runtimeStub = createRuntimeStub();
    const manager = {
      getStatuses: () => [],
      onStatusChange: () => () => undefined,
    };
    startRelayStatusPort(manager as never, runtimeStub as never);

    const port = runtimeStub.emitConnect(RELAY_STATUS_PORT_NAME);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toEqual({ type: 'snapshot', statuses: [] });
  });
});
