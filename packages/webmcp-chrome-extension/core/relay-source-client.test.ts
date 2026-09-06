import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LnaPermissionState } from './relay-lna-permission';
import {
  RELAY_BROWSER_PROTOCOL,
  RELAY_DISCOVERY_PROTOCOL,
  RelaySourceClient,
  type RelayConnectionStatus,
  type RelaySocket,
  type RelayToolsFacade,
} from './relay-source-client';

/** 测试桩 WebSocket：同步收发，记录发送内容，可编程触发 close/error。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.instances = [];
  }

  readyState = 1; // OPEN
  closed = false;
  sent: string[] = [];
  /** 关闭码（供 close(4000) 断言）。 */
  closeCode: number | undefined;

  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close', {});
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** 模拟收到一条 relay 消息。 */
  receive(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  /** 微任务时机模拟连接失败（探测/重连路径）。 */
  failAsynchronously(): void {
    queueMicrotask(() => {
      if (!this.closed) {
        this.emit('error', { message: 'connection refused' });
      }
    });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** 页面工具门面桩。 */
function createFacadeStub(overrides: Partial<RelayToolsFacade> = {}): RelayToolsFacade & {
  emitToolsChanged(): void;
} {
  const toolsChangedListeners = new Set<() => void>();
  return {
    listTools: vi.fn(async () => [
      { name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } },
    ]),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    onToolsChanged: vi.fn((listener: () => void) => {
      toolsChangedListeners.add(listener);
      return () => {
        toolsChangedListeners.delete(listener);
      };
    }),
    emitToolsChanged: () => {
      for (const listener of toolsChangedListeners) {
        listener();
      }
    },
    ...overrides,
  };
}

const SOURCE = { tabId: '42', origin: 'https://example.com', url: 'https://example.com/', title: 'Example' };

/** 冲刷微任务：真实 WS 事件为宏任务，探测激活（activateSocket）完成后才应投递后续消息。 */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 注入 FakeSocket 的客户端构造辅助。 */
function createClient(overrides: Partial<ConstructorParameters<typeof RelaySourceClient>[0]> = {}): RelaySourceClient {
  return new RelaySourceClient({
    source: SOURCE,
    facade: createFacadeStub(),
    socketFactory: (url, protocols) => new FakeSocket(url, protocols) as unknown as RelaySocket,
    ...overrides,
  });
}

afterEach(() => {
  FakeSocket.reset();
  vi.restoreAllMocks();
  // 必须用 isFakeTimers 判断：vitest 5 的 fake timers 基于 sinon 实现，
  // 全局 setTimeout 不是 vi.fn()，isMockFunction(setTimeout) 恒为 false，
  // 导致 useFakeTimers 后真实定时器永不恢复、泄漏到同文件后续用例
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});

describe('RelaySourceClient 发现与握手', () => {
  it('构造即扫描提示端口，收到 server-hello 后发送 hello 并携带源元数据', async () => {
    const facade = createFacadeStub();
    const client = createClient({ facade, autoConnect: false });
    client.start();

    await vi.waitFor(() => {
      expect(FakeSocket.instances).toHaveLength(1);
    });
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:9333');
    expect(socket.protocols).toEqual([RELAY_DISCOVERY_PROTOCOL, RELAY_BROWSER_PROTOCOL]);

    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });

    await vi.waitFor(() => {
      expect(socket.sent.some((m) => m.includes('"type":"hello"'))).toBe(true);
    });
    const hello = JSON.parse(socket.sent.find((m) => m.includes('"type":"hello"'))!) as Record<string, unknown>;
    expect(hello).toMatchObject({
      type: 'hello',
      tabId: '42',
      origin: 'https://example.com',
      url: 'https://example.com/',
      title: 'Example',
    });
    client.stop();
  });

  it('hello/accepted 后发送 tools/list 初始工具清单并写入端点缓存', async () => {
    const writeCachedEndpoint = vi.fn();
    const facade = createFacadeStub();
    const client = createClient({ facade, autoConnect: false, writeCachedEndpoint });
    client.start();

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await flushAsync();
    socket.receive({ type: 'hello/accepted' });

    await vi.waitFor(() => {
      expect(writeCachedEndpoint).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9333 });
    });
    const toolsList = socket.sent.find((m) => m.includes('"type":"tools/list"'));
    expect(toolsList).toBeDefined();
    expect(JSON.parse(toolsList!)).toMatchObject({
      type: 'tools/list',
      tools: [{ name: 'get_status' }],
    });
    client.stop();
  });

  it('hello/rejected 时清理端点缓存并关闭连接', async () => {
    const clearCachedEndpoint = vi.fn();
    const facade = createFacadeStub();
    const client = createClient({ facade, autoConnect: false, clearCachedEndpoint });
    client.start();

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await flushAsync();
    socket.receive({ type: 'hello/rejected', reason: 'host-origin-not-allowed', message: 'nope' });

    expect(clearCachedEndpoint).toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    client.stop();
  });

  it('非 loopback 的 hostHint 在构造时直接拒绝', () => {
    const facade = createFacadeStub();
    expect(
      () =>
        createClient({
          facade,
          autoConnect: false,
          hostHint: 'example.com',
        })
    ).toThrow('loopback');
  });
});

describe('RelaySourceClient 运行期消息', () => {
  /** 建立到已接受握手的活跃连接。 */
  async function connectAccepted(
    facadeOverrides: Partial<RelayToolsFacade> = {}
  ): Promise<{ client: RelaySourceClient; socket: FakeSocket; facade: ReturnType<typeof createFacadeStub> }> {
    const facade = createFacadeStub(facadeOverrides);
    const client = createClient({ facade, autoConnect: false, invokeTimeoutMs: 20 });
    client.start();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await flushAsync();
    socket.receive({ type: 'hello/accepted' });
    await vi.waitFor(() => {
      expect(socket.sent.some((m) => m.includes('"type":"tools/list"'))).toBe(true);
    });
    return { client, socket, facade };
  }

  it('invoke 转发到 facade.callTool 并回传 result', async () => {
    const { client, socket, facade } = await connectAccepted();
    socket.receive({ type: 'invoke', callId: 'call-1', toolName: 'get_status', args: { a: 1 } });

    await vi.waitFor(() => {
      expect(facade.callTool).toHaveBeenCalledWith('get_status', { a: 1 });
      expect(socket.sent.some((m) => m.includes('"type":"result"'))).toBe(true);
    });
    const result = JSON.parse(socket.sent.find((m) => m.includes('"type":"result"'))!) as Record<string, unknown>;
    expect(result).toMatchObject({ type: 'result', callId: 'call-1' });
    client.stop();
  });

  it('callTool 失败时回传 isError result，不使 MCP Client 悬挂', async () => {
    const { client, socket } = await connectAccepted({
      callTool: vi.fn(async () => {
        throw new Error('tool exploded');
      }),
    });
    socket.receive({ type: 'invoke', callId: 'call-2', toolName: 'boom', args: {} });

    await vi.waitFor(() => {
      const result = socket.sent.find((m) => m.includes('"type":"result"'));
      expect(result).toBeDefined();
      expect(JSON.parse(result!)).toMatchObject({
        type: 'result',
        callId: 'call-2',
        result: { isError: true },
      });
    });
    client.stop();
  });

  it('ping 回 pong', async () => {
    const { client, socket } = await connectAccepted();
    socket.receive({ type: 'ping' });
    expect(socket.sent.some((m) => m.includes('"type":"pong"'))).toBe(true);
    client.stop();
  });

  it('reload 下发时触发 onReload 自愈回调', async () => {
    const onReload = vi.fn();
    const facade = createFacadeStub();
    const client = createClient({ facade, autoConnect: false, onReload });
    client.start();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    FakeSocket.instances[0]!.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await flushAsync();
    FakeSocket.instances[0]!.receive({ type: 'reload' });
    expect(onReload).toHaveBeenCalled();
    client.stop();
  });

  it('toolsChanged 通知在握手接受后转发为 tools/changed', async () => {
    const { client, socket, facade } = await connectAccepted();
    facade.emitToolsChanged();
    await vi.waitFor(() => {
      expect(socket.sent.some((m) => m.includes('"type":"tools/changed"'))).toBe(true);
    });
    client.stop();
  });

  it('调用超时回传 isError result', async () => {
    const facade = createFacadeStub({
      callTool: vi.fn(() => new Promise(() => undefined)),
    });
    const client = createClient({ facade, autoConnect: false, invokeTimeoutMs: 10 });
    client.start();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await flushAsync();
    socket.receive({ type: 'hello/accepted' });
    await flushAsync();
    socket.receive({ type: 'invoke', callId: 'call-3', toolName: 'slow', args: {} });

    await vi.waitFor(() => {
      const result = socket.sent.find((m) => m.includes('"call-3"'));
      expect(result).toBeDefined();
      expect(JSON.parse(result!)).toMatchObject({ result: { isError: true } });
    });
    client.stop();
  });

  it('hello accepted 后按 2s/5s/10s 有限次重推工具快照（对账兜底）', async () => {
    vi.useFakeTimers();
    const facade = createFacadeStub();
    const client = createClient({ facade, autoConnect: false });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await vi.advanceTimersByTimeAsync(0);
    socket.receive({ type: 'hello/accepted' });
    await vi.advanceTimersByTimeAsync(0);

    const pushes = (): number => socket.sent.filter((m) => m.includes('"type":"tools/changed"')).length;
    expect(socket.sent.some((m) => m.includes('"type":"tools/list"'))).toBe(true);
    expect(pushes()).toBe(0);

    // 2s → 1 次重推；5s → 累计 2 次；10s → 累计 3 次；此后不再推
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pushes()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pushes()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pushes()).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pushes()).toBe(3);

    client.stop();
  });

  it('toolsChanged 推送失败后单次重试成功（不使 registry 停留旧快照）', async () => {
    vi.useFakeTimers();
    let listToolsCalls = 0;
    const facade = createFacadeStub({
      listTools: vi.fn(async () => {
        listToolsCalls += 1;
        // 第 1 次 = 握手初始快照（成功）；第 2 次 = toolsChanged 推送（失败）；之后恢复
        if (listToolsCalls === 2) {
          throw new Error('port busy');
        }
        return [{ name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } }];
      }),
    });
    const client = createClient({ facade, autoConnect: false });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await vi.advanceTimersByTimeAsync(0);
    socket.receive({ type: 'hello/accepted' });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.some((m) => m.includes('"type":"tools/list"'))).toBe(true);

    // 推送失败：无 tools/changed 发出
    facade.emitToolsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.some((m) => m.includes('"type":"tools/changed"'))).toBe(false);

    // 1.5s 后单次重试成功
    await vi.advanceTimersByTimeAsync(1_500);
    expect(socket.sent.filter((m) => m.includes('"type":"tools/changed"'))).toHaveLength(1);

    // 后续 toolsChanged 正常推送，不再叠加重试
    facade.emitToolsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.filter((m) => m.includes('"type":"tools/changed"'))).toHaveLength(2);

    client.stop();
  });
});

describe('RelaySourceClient 断线恢复状态机', () => {
  it('断线后重试同端点失败，重扫序列耗尽进入 dormant，心跳探测失败后保持 dormant', async () => {
    vi.useFakeTimers();
    const facade = createFacadeStub();
    // 所有连接立即失败（微任务内 error）：探测不占用 1.2s 超时，重扫时序只由重试间隔主导
    const client = createClient({
      facade,
      autoConnect: false,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        socket.failAsynchronously();
        return socket as unknown as RelaySocket;
      },
    });
    client.start();

    // 首轮发现：所有候选端口连接失败（socket 微任务内 error）
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances.length).toBeGreaterThan(0);
    // 全范围重扫 10s/20s/30s 三轮 + 首轮，全部失败后进入 dormant
    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.isDormant()).toBe(true);

    // dormant 心跳探测（2min）依旧失败 → 保持 dormant
    const socketsBeforeHeartbeat = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(socketsBeforeHeartbeat);
    expect(client.isDormant()).toBe(true);

    client.stop();
  });

  it('stop() 释放定时器与连接后不再发起任何重连', async () => {
    vi.useFakeTimers();
    const facade = createFacadeStub();
    const client = createClient({ facade, autoConnect: false });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();

    const socketsAtStop = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances.length).toBe(socketsAtStop);
  });
});

describe('RelaySourceClient LNA 权限拦截提示', () => {
  /** 构造「探测全部立即失败」的客户端（LNA 拦截与端口拒绝的公共前置）。 */
  function createAlwaysFailingClient(
    overrides: Partial<ConstructorParameters<typeof RelaySourceClient>[0]> = {}
  ): RelaySourceClient {
    return createClient({
      autoConnect: false,
      debugLog: false,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        socket.failAsynchronously();
        return socket as unknown as RelaySocket;
      },
      ...overrides,
    });
  }

  it('dormant 后 LNA 权限为 denied 时，状态携带 lnaBlocked 与修复路径提示', async () => {
    vi.useFakeTimers();
    const statuses: RelayConnectionStatus[] = [];
    const queryLoopbackPermission = vi.fn(async (): Promise<LnaPermissionState> => 'denied');
    const client = createAlwaysFailingClient({ onStatusChange: (status) => statuses.push(status), queryLoopbackPermission });
    client.start();

    // 首轮发现 + 10s/20s/30s 三轮重扫全部失败 → dormant → 触发 LNA 检测
    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.isDormant()).toBe(true);
    // 冲刷 checkLnaBlocked 的异步查询（fake timers 同步冲刷微任务）
    await vi.advanceTimersByTimeAsync(0);

    const last = statuses.at(-1)!;
    expect(last.state).toBe('dormant');
    expect(last.lnaBlocked).toBe(true);
    expect(last.detail).toContain('本地网络访问');
    expect(last.detail).toContain('chrome://extensions');
    expect(queryLoopbackPermission).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('LNA 权限为 prompt 时同样标记拦截（SW 无弹窗面，需手动授权）', async () => {
    vi.useFakeTimers();
    const statuses: RelayConnectionStatus[] = [];
    const client = createAlwaysFailingClient({
      onStatusChange: (status) => statuses.push(status),
      queryLoopbackPermission: async () => 'prompt',
    });
    client.start();
    await vi.advanceTimersByTimeAsync(70_000);
    await vi.advanceTimersByTimeAsync(0);

    const last = statuses.at(-1)!;
    expect(last.lnaBlocked).toBe(true);
    expect(last.detail).toContain('无法弹窗');
    client.stop();
  });

  it('LNA 权限 granted 或 unsupported 时不标记拦截（避免误导用户）', async () => {
    vi.useFakeTimers();
    for (const state of ['granted', 'unsupported'] as const) {
      FakeSocket.reset();
      const statuses: RelayConnectionStatus[] = [];
      const client = createAlwaysFailingClient({
        onStatusChange: (status) => statuses.push(status),
        queryLoopbackPermission: async () => state,
      });
      client.start();
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(client.isDormant()).toBe(true);
      expect(statuses.every((status) => status.lnaBlocked === undefined)).toBe(true);
      client.stop();
    }
  });

  it('重扫进入 dormant 仅检测一次（lnaBlocked 已标记后不重复查询）', async () => {
    vi.useFakeTimers();
    const queryLoopbackPermission = vi.fn(async (): Promise<LnaPermissionState> => 'denied');
    const client = createAlwaysFailingClient({ queryLoopbackPermission });
    client.start();
    await vi.advanceTimersByTimeAsync(70_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryLoopbackPermission).toHaveBeenCalledTimes(1);

    // dormant 心跳再失败 → 再入 dormant → 不重复 LNA 查询
    const callsAfterFirstCheck = queryLoopbackPermission.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.isDormant()).toBe(true);
    expect(queryLoopbackPermission.mock.calls.length).toBe(callsAfterFirstCheck);
    client.stop();
  });
});

describe('RelaySourceClient 连接状态', () => {
  it('状态迁移：connecting → connected（携带端点与工具数），tools/changed 增量更新 toolsCount', async () => {
    const facade = createFacadeStub();
    const statuses: RelayConnectionStatus[] = [];
    const client = createClient({
      facade,
      autoConnect: false,
      debugLog: false,
      onStatusChange: (status) => statuses.push(status),
    });
    client.start();

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await flushAsync();
    socket.receive({ type: 'hello/accepted' });

    await vi.waitFor(() => {
      expect(statuses.at(-1)).toMatchObject({
        state: 'connected',
        toolsCount: 1,
        endpoint: { host: '127.0.0.1', port: 9333 },
      });
    });
    // 首条状态为 connecting（开始发现），且全程经过 handshaking
    expect(statuses[0]).toMatchObject({ state: 'connecting' });
    expect(statuses.some((s) => s.detail?.includes('handshaking'))).toBe(true);

    // 页面工具清单变化 → tools/changed → toolsCount 增量更新（state 保持 connected）
    facade.listTools = vi.fn(async () => [
      { name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } },
      { name: 'extra_tool', description: 'Extra', inputSchema: { type: 'object' } },
    ]);
    facade.emitToolsChanged();
    await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: 'connected', toolsCount: 2 });
    });
    client.stop();
  });

  it('连接断开 → reconnecting，stop() → stopped；后订阅者立即收到最近状态', async () => {
    const facade = createFacadeStub();
    const statuses: RelayConnectionStatus[] = [];
    const client = createClient({
      facade,
      autoConnect: false,
      debugLog: false,
      onStatusChange: (status) => statuses.push(status),
    });
    client.start();

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'server-hello',
      service: 'webmcp-extension-relay',
      version: 1,
      host: '127.0.0.1',
      instanceId: 'inst-1',
      port: 9333,
    });
    await flushAsync();
    socket.receive({ type: 'hello/accepted' });
    await vi.waitFor(() => {
      expect(statuses.at(-1)).toMatchObject({ state: 'connected' });
    });

    // relay 侧断开 → close 回调 → reconnecting（含重试说明）
    socket.close();
    await vi.waitFor(() => {
      expect(statuses.at(-1)).toMatchObject({ state: 'reconnecting' });
    });

    client.stop();
    const late: RelayConnectionStatus[] = [];
    client.onStatus((status) => late.push(status));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ state: 'stopped', endpoint: null });
  });
});
