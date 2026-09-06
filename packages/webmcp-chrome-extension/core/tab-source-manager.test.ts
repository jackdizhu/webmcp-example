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
  /** 当前活动标签页（null = 无活动页签；auto 模式默认选中它）。 */
  activeTabId: number | null;
  emitUpdated(tabId: number, changeInfo: { status?: string; url?: string }, tab: { id?: number; url?: string; title?: string }): void;
  emitRemoved(tabId: number): void;
  emitActivated(tabId: number): void;
} {
  const tabs = new Map<number, { id: number; url?: string; title?: string }>();
  const ports: FakePort[] = [];
  const updatedListeners = new Set<TabsApi['onUpdated'] extends { addListener(cb: infer C): void } ? C : never>();
  const removedListeners = new Set<(tabId: number) => void>();
  const activatedListeners = new Set<(activeInfo: { tabId: number }) => void>();
  const state: { activeTabId: number | null } = { activeTabId: null };

  /** 简化版 URL 模式匹配：仅支持 rescan 用到的两种模式。 */
  const matchesUrlPattern = (url: string | undefined, patterns: string[]): boolean =>
    typeof url === 'string' &&
    patterns.some((pattern) =>
      pattern === 'http://*/*' ? url.startsWith('http://') : pattern === 'https://*/*' ? url.startsWith('https://') : false
    );

  return {
    tabs,
    ports,
    get activeTabId() {
      return state.activeTabId;
    },
    set activeTabId(value: number | null) {
      state.activeTabId = value;
    },
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
    emitActivated: (tabId) => {
      for (const listener of activatedListeners) {
        listener({ tabId });
      }
    },
    get: async (tabId) => tabs.get(tabId) ?? { id: tabId },
    query: async (queryInfo) => {
      let result = [...tabs.values()];
      if (queryInfo.url) {
        const patterns = queryInfo.url;
        result = result.filter((tab) => matchesUrlPattern(tab.url, patterns));
      }
      if (queryInfo.active === true) {
        result = result.filter((tab) => tab.id === state.activeTabId);
      }
      return result;
    },
    connect: (_tabId) => {
      const port = new FakePort(PAGE_TOOLS_PORT_NAME);
      ports.push(port);
      return port as unknown as chrome.runtime.Port;
    },
    reload: vi.fn(async () => undefined),
    onActivated: {
      addListener: (listener) => activatedListeners.add(listener),
      removeListener: (listener) => activatedListeners.delete(listener),
    },
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
  /** notifySourceDisconnected 调用记录（C.2 注册表一致性验证）。 */
  disconnectNotices: string[];
  /** reconnectRelay 调用次数（relay 连接手动刷新验证）。 */
  reconnectRelayCalls: number;
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
      disconnectNotices: [],
      reconnectRelayCalls: 0,
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
      notifySourceDisconnected: (reason) => {
        stub.disconnectNotices.push(reason);
      },
      reconnectRelay: () => {
        stub.reconnectRelayCalls += 1;
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

/** 内存标签页选择存储（记录 write 历史，供持久化断言）。 */
function createMemorySelectionStore() {
  const values: Array<{ mode: 'auto' | 'manual'; tabIds: number[] }> = [];
  let current: { mode: 'auto' | 'manual'; tabIds: number[] } | null = null;
  return {
    values,
    read: async () => current,
    write: async (value: { mode: 'auto' | 'manual'; tabIds: number[] }) => {
      values.push({ mode: value.mode, tabIds: [...value.tabIds] });
      current = { mode: value.mode, tabIds: [...value.tabIds] };
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('startTabSourceManager', () => {
  it('启动时重扫：默认自动模式仅活动标签页创建源客户端，其余 http 页签登记不连接', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/page', title: 'A' });
    tabsStub.tabs.set(2, { id: 2, url: 'https://b.com/page', title: 'B' });
    tabsStub.tabs.set(3, { id: 3, url: 'chrome://version', title: 'Chrome' });
    tabsStub.activeTabId = 1;
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
    // 选中页签建立连接；未选中的 http 页签出现在快照（checkbox 数据源）但不建 Port
    expect(tabsStub.ports).toHaveLength(1);
    const statusById = new Map(manager.getStatuses().map((status) => [status.tabId, status]));
    expect(statusById.get(1)).toMatchObject({ selected: true, state: 'stopped' });
    expect(statusById.get(2)).toMatchObject({ selected: false, state: 'stopped', url: 'https://b.com/page' });
    // chrome:// 页签不进清单
    expect(statusById.has(3)).toBe(false);
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
      events.push({ phase, entry: { callId: entry.callId, ...(entry.ok !== undefined ? { ok: entry.ok } : {}) } });
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
    tabsStub.tabs.set(7, { id: 7, url: 'https://b.com/', title: 'B' });
    tabsStub.activeTabId = 7;
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
    tabsStub.tabs.set(9, { id: 9, url: 'https://c.com/', title: 'C' });
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.activeTabId = 9;
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
    tabsStub.tabs.set(5, { id: 5, url: 'https://d.com/', title: 'D' });
    tabsStub.activeTabId = 5;
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
    tabsStub.tabs.set(3, { id: 3, url: 'https://e.com/', title: 'E1' });
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.activeTabId = 3;
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
    tabsStub.tabs.set(11, { id: 11, url: 'https://f.com/', title: 'F' });
    tabsStub.activeTabId = 11;
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
    tabsStub.tabs.set(21, { id: 21, url: 'https://h.com/', title: 'H' });
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.activeTabId = 21;
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
    tabsStub.tabs.set(31, { id: 31, url: 'https://j.com/', title: 'J' });
    tabsStub.activeTabId = 31;
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
    tabsStub.tabs.set(41, { id: 41, url: 'https://k.com/', title: 'K' });
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    tabsStub.activeTabId = 41;
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
      tabsStub.activeTabId = 1;
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
      tabsStub.activeTabId = 1;
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
      tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
      const { stubs, factory } = createClientStubFactory();
      const reinject = vi.fn(async () => undefined);
      const manager = startTabSourceManager({
        tabsApi: tabsStub,
        clientFactory: factory,
        endpointCache: createMemoryCache(),
        reinjectContentScripts: reinject,
      });

      // 第一次导航：建立客户端 → 意外断连 → 自愈重建（attempt=1，下次退避 2s）
      tabsStub.activeTabId = 1;
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

  it('竞态修复：Port 断连先于导航完成时，complete 回调强制重建死 Port 条目', async () => {
    vi.useFakeTimers();
    try {
      const tabsStub = createTabsStub();
      tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
      const { stubs, factory } = createClientStubFactory();
      const manager = startTabSourceManager({
        tabsApi: tabsStub,
        clientFactory: factory,
        endpointCache: createMemoryCache(),
      });

      tabsStub.activeTabId = 1;
      // 建立客户端（模拟 rescan / 首次导航完成）
      tabsStub.emitUpdated(1, { status: 'complete' }, { id: 1, url: 'https://a.com/', title: 'A' });
      await vi.waitFor(() => {
        expect(stubs).toHaveLength(1);
      });

      // Port 意外死亡（页面 reload 中的旧上下文销毁）→ healPort 排 1s 延迟自愈
      tabsStub.ports[0]!.disconnect();
      expect(stubs[0]!.disconnectNotices).toHaveLength(1);

      // 导航完成先于自愈延迟任务：取消 healTimer + 检测死 Port 残留 → 强制重建
      tabsStub.emitUpdated(1, { status: 'complete' }, { id: 1, url: 'https://a.com/', title: 'A' });
      await vi.waitFor(() => {
        expect(stubs).toHaveLength(2);
      });
      // 旧条目被 dispose（stop 调用），新条目持有全新 Port
      expect(stubs[0]!.stop).toHaveBeenCalled();
      expect(stubs[1]!.start).toHaveBeenCalled();
      expect(tabsStub.ports).toHaveLength(2);

      // 旧 healPort 延迟任务已被取消：推进时间不再触发额外重建
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stubs).toHaveLength(2);
      manager.stop();
    } finally {
      if (vi.isFakeTimers()) {
        vi.useRealTimers();
      }
    }
  });

  it('手动刷新：recreateConnectionForActive 重建 webmcp 连接（新 Port + 新客户端）', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    await vi.waitFor(() => {
      expect(stubs).toHaveLength(1);
    });

    const recreated = await manager.recreateConnectionForActive('webmcp');
    expect(recreated).toBe(true);
    await vi.waitFor(() => {
      expect(stubs).toHaveLength(2);
    });
    // 旧条目销毁 + 全新 Port 建立
    expect(stubs[0]!.stop).toHaveBeenCalled();
    expect(stubs[1]!.start).toHaveBeenCalled();
    expect(tabsStub.ports).toHaveLength(2);
    manager.stop();
  });

  it('手动刷新：relay 模式仅重连 WebSocket，不动 Port 与客户端条目', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    await vi.waitFor(() => {
      expect(stubs).toHaveLength(1);
    });

    const recreated = await manager.recreateConnectionForActive('relay');
    expect(recreated).toBe(true);
    expect(stubs[0]!.reconnectRelayCalls).toBe(1);
    // Port 与客户端条目保持不动
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.stop).not.toHaveBeenCalled();
    expect(tabsStub.ports).toHaveLength(1);
    manager.stop();
  });

  it('手动刷新：目标标签页未登记时返回 false', async () => {
    const tabsStub = createTabsStub();
    const { factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });
    // 无任何 http(s) 标签页 → 活动标签页不存在
    expect(await manager.recreateConnectionForActive('webmcp')).toBe(false);
    manager.stop();
  });

  // ---- 标签页数据源选择（默认活动页签单选 + checkbox 多选门控）----

  it('setSelection 多选：手动模式连接全部选中页签并持久化', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.tabs.set(2, { id: 2, url: 'https://b.com/', title: 'B' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const store = createMemorySelectionStore();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
      selectionStore: store,
    });

    await vi.waitFor(() => expect(stubs).toHaveLength(1)); // 默认仅活动页签
    await manager.setSelection([1, 2]);
    await vi.waitFor(() => expect(stubs).toHaveLength(2));
    expect(stubs.map((stub) => stub.input.tabId).sort()).toEqual([1, 2]);
    expect(store.values.at(-1)).toEqual({ mode: 'manual', tabIds: [1, 2] });
    const statusById = new Map(manager.getStatuses().map((status) => [status.tabId, status]));
    expect(statusById.get(1)?.selected).toBe(true);
    expect(statusById.get(2)?.selected).toBe(true);
    expect(manager.getSelection()).toEqual({ mode: 'manual', tabIds: [1, 2] });
    manager.stop();
  });

  it('setSelection(null) 恢复默认：仅活动页签，其余选中页签连接被释放', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.tabs.set(2, { id: 2, url: 'https://b.com/', title: 'B' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const store = createMemorySelectionStore();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
      selectionStore: store,
    });

    await manager.setSelection([1, 2]);
    await vi.waitFor(() => expect(stubs).toHaveLength(2));
    await manager.setSelection(null);
    await vi.waitFor(() => expect(stubs[1]!.stop).toHaveBeenCalled());
    // stubs 是追加式创建记录（释放不缩短），以 stop/disconnect 断言连接释放
    expect(stubs[0]!.input.tabId).toBe(1);
    expect(stubs[0]!.stop).not.toHaveBeenCalled();
    expect(stubs[1]!.input.tabId).toBe(2);
    expect(tabsStub.ports[1]!.disconnected).toBe(true);
    expect(manager.getSelection()).toEqual({ mode: 'auto', tabIds: [1] });
    expect(store.values.at(-1)).toEqual({ mode: 'auto', tabIds: [1] });
    manager.stop();
  });

  it('自动模式下切换活动标签页：旧源释放、新源建立（跟随当前页签）', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.tabs.set(2, { id: 2, url: 'https://b.com/', title: 'B' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    await vi.waitFor(() => expect(stubs).toHaveLength(1));
    tabsStub.emitActivated(2);
    await vi.waitFor(() => expect(stubs).toHaveLength(2));
    expect(stubs[1]!.input.tabId).toBe(2);
    expect(stubs[0]!.stop).toHaveBeenCalled();
    expect(manager.getSelection()).toEqual({ mode: 'auto', tabIds: [2] });
    manager.stop();
  });

  it('手动模式下切换活动标签页不影响选择', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.tabs.set(2, { id: 2, url: 'https://b.com/', title: 'B' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    await manager.setSelection([1]);
    await vi.waitFor(() => expect(stubs).toHaveLength(1));
    tabsStub.emitActivated(2);
    await vi.waitFor(() => expect(manager.getSelection()).toEqual({ mode: 'manual', tabIds: [1] }));
    // 选中集不变：没有新客户端，也没有释放
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.input.tabId).toBe(1);
    expect(stubs[0]!.stop).not.toHaveBeenCalled();
    manager.stop();
  });

  it('未选中标签页导航完成不建立连接（relay 端获取不到其数据）', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
    });

    await vi.waitFor(() => expect(stubs).toHaveLength(1));
    // 后台页签导航完成：无 Port、无客户端，但登记进快照（checkbox 可勾选）
    tabsStub.emitUpdated(9, { status: 'complete' }, { id: 9, url: 'https://c.com/', title: 'C' });
    await vi.waitFor(() => {
      const statusById = new Map(manager.getStatuses().map((status) => [status.tabId, status]));
      expect(statusById.get(9)).toMatchObject({ selected: false, state: 'stopped' });
    });
    expect(stubs).toHaveLength(1);
    expect(tabsStub.ports).toHaveLength(1);
    manager.stop();
  });

  it('关闭已选中的标签页：从选择集合移除并持久化', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const store = createMemorySelectionStore();
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
      selectionStore: store,
    });

    await vi.waitFor(() => expect(stubs).toHaveLength(1));
    tabsStub.emitRemoved(1);
    await vi.waitFor(() => {
      expect(manager.getSelection()).toEqual({ mode: 'auto', tabIds: [] });
      expect(manager.getStatuses()).toHaveLength(0);
    });
    expect(stubs[0]!.stop).toHaveBeenCalled();
    expect(store.values.at(-1)).toEqual({ mode: 'auto', tabIds: [] });
    manager.stop();
  });

  it('存储恢复：手动选择跨 SW 重启保留，仅选中页签重连', async () => {
    const tabsStub = createTabsStub();
    tabsStub.tabs.set(1, { id: 1, url: 'https://a.com/', title: 'A' });
    tabsStub.tabs.set(2, { id: 2, url: 'https://b.com/', title: 'B' });
    tabsStub.activeTabId = 1;
    const { stubs, factory } = createClientStubFactory();
    const store = createMemorySelectionStore();
    await store.write({ mode: 'manual', tabIds: [2] });
    const manager = startTabSourceManager({
      tabsApi: tabsStub,
      clientFactory: factory,
      endpointCache: createMemoryCache(),
      selectionStore: store,
    });

    await vi.waitFor(() => expect(stubs).toHaveLength(1));
    // 活动页签是 1，但手动选择只勾了 2 → 只连 2
    expect(stubs[0]!.input.tabId).toBe(2);
    expect(manager.getSelection()).toEqual({ mode: 'manual', tabIds: [2] });
    manager.stop();
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

  it('刷新指令消息分发：webmcp-reconnect/relay-reconnect 转发到 recreateConnectionForActive', async () => {
    const runtimeStub = createRuntimeStub();
    const calls: string[] = [];
    const manager = {
      getStatuses: () => [],
      onStatusChange: () => () => undefined,
      recreateConnectionForActive: async (mode: 'webmcp' | 'relay') => {
        calls.push(mode);
        return true;
      },
    };
    startRelayStatusPort(manager as never, runtimeStub as never);

    const port = runtimeStub.emitConnect(RELAY_STATUS_PORT_NAME);
    port.receive({ type: 'webmcp-reconnect' });
    port.receive({ type: 'relay-reconnect' });
    port.receive({ type: 'unknown-command' });

    await vi.waitFor(() => {
      expect(calls).toEqual(['webmcp', 'relay']);
    });
  });

  it('标签页选择：连接即推送 selection，set-selection 转发且畸形负载忽略', async () => {
    const runtimeStub = createRuntimeStub();
    const calls: Array<number[] | null> = [];
    const selectionListeners = new Set<(selection: { mode: 'auto' | 'manual'; tabIds: number[] }) => void>();
    const manager = {
      getStatuses: () => [],
      onStatusChange: () => () => undefined,
      getSelection: () => ({ mode: 'auto' as const, tabIds: [7] }),
      setSelection: (tabIds: number[] | null) => {
        calls.push(tabIds);
      },
      onSelectionChange: (listener: (selection: { mode: 'auto' | 'manual'; tabIds: number[] }) => void) => {
        selectionListeners.add(listener);
        return () => {
          selectionListeners.delete(listener);
        };
      },
    };
    startRelayStatusPort(manager as never, runtimeStub as never);

    const port = runtimeStub.emitConnect(RELAY_STATUS_PORT_NAME);
    expect(port.sent[0]).toEqual({ type: 'snapshot', statuses: [] });
    expect(port.sent[1]).toEqual({ type: 'selection', mode: 'auto', tabIds: [7] });

    port.receive({ type: 'set-selection', tabIds: [7, 8] });
    port.receive({ type: 'set-selection', tabIds: null });
    port.receive({ type: 'set-selection', tabIds: 'bogus' });
    port.receive({ type: 'set-selection', tabIds: [1, 'x'] });
    await vi.waitFor(() => {
      expect(calls).toEqual([[7, 8], null]);
    });

    // 选择变化推送 selection 消息
    for (const listener of selectionListeners) {
      listener({ mode: 'manual', tabIds: [7, 8] });
    }
    expect(port.sent.at(-1)).toEqual({ type: 'selection', mode: 'manual', tabIds: [7, 8] });

    // 断开后取消选择订阅
    port.disconnect();
    expect(selectionListeners).toHaveLength(0);
  });
});
