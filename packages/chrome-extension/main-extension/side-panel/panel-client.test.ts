// panel-client 断线自动重连逻辑单测。
// 用桩 Port 模拟"接收端不存在 → 立即断开"与"稍后恢复"两种场景（fake timers 驱动退避）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectPageTools } from './panel-client';
import type { PageToolsRequest, PageToolsResponse } from '../../core/page-tools-bridge';

type MessageListener = (message: unknown) => void;
type DisconnectListener = () => void;

/** Chrome connect 失败时写入 lastError 的原文（未消费会触发 Unchecked 告警）。 */
const CONNECT_ERROR_MESSAGE = 'Could not establish connection. Receiving end does not exist.';

/** globalThis 上的 chrome 桩句柄（模拟真实运行时由 Chrome 注入的全局）。 */
type ChromeGlobal = { runtime: { lastError?: { message: string } } };

function setChromeLastError(message: string | undefined): void {
  const holder = globalThis as { chrome?: ChromeGlobal };
  if (message === undefined) {
    delete holder.chrome;
    return;
  }
  holder.chrome = { runtime: { lastError: { message } } };
}

/** chrome.runtime.Port 桩：可配置连接后立即断开，或对请求回响应。 */
class StubPort {
  private readonly messageListeners: MessageListener[] = [];
  private readonly disconnectListeners: DisconnectListener[] = [];
  readonly posted: unknown[] = [];

  constructor(
    private readonly options: {
      /** 连接后立即触发 onDisconnect（模拟接收端不存在）。 */
      dieImmediately?: boolean;
      /** 对每个请求回 ok 响应（模拟已就绪的桥接）。 */
      responder?: (request: PageToolsRequest) => PageToolsResponse;
    } = {}
  ) {}

  get onMessage() {
    return {
      addListener: (fn: MessageListener) => this.messageListeners.push(fn),
      removeListener: () => {},
    };
  }

  get onDisconnect() {
    return {
      addListener: (fn: DisconnectListener) => this.disconnectListeners.push(fn),
      removeListener: () => {},
    };
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
    if (this.options.dieImmediately) {
      // Chrome 行为：无接收端时 onDisconnect 异步触发，且 lastError 携带失败原因
      queueMicrotask(() => this.drop(CONNECT_ERROR_MESSAGE));
      return;
    }
    const request = message as PageToolsRequest;
    const response = this.options.responder?.(request);
    if (response) {
      queueMicrotask(() => {
        for (const fn of this.messageListeners) fn(response);
      });
    }
  }

  disconnect(): void {
    // 发起方主动断开不触发自身 onDisconnect（与 Chrome 一致）
  }

  /** 模拟对端断开；lastErrorMessage 非空时模拟 Chrome 在监听器执行期间暴露 lastError。 */
  drop(lastErrorMessage?: string): void {
    setChromeLastError(lastErrorMessage);
    try {
      for (const fn of this.disconnectListeners) fn();
    } finally {
      setChromeLastError(undefined);
    }
  }
}

const asPort = (stub: StubPort): chrome.runtime.Port => stub as unknown as chrome.runtime.Port;

describe('connectPageTools 断线自动重连', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次请求遭遇即断端口后拒绝，退避后自动重连成功', async () => {
    let created = 0;
    const client = connectPageTools(() => {
      created += 1;
      if (created <= 2) {
        // 前两次：接收端不存在，端口即断
        return asPort(new StubPort({ dieImmediately: true }));
      }
      // 第三次：桥接就绪
      return asPort(
        new StubPort({
          responder: (request) => ({ id: request.id, ok: true, result: [] }),
        })
      );
    });

    const statuses: boolean[] = [];
    client.onStatusChange((value) => statuses.push(value));

    // 第一次请求（挂在前两个即断端口上）失败
    await expect(client.listTools()).rejects.toThrow('与页面工具桥接的连接已断开');
    // 1s 退避 → 第二个即断端口 → 再退避 2s → 第三个端口探活成功
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    const tools = await client.listTools();
    expect(tools).toEqual([]);
    expect(created).toBe(3);
    // 状态收敛为在线，且在线只出现一次（首条响应到达时置位，Port 建立时不置位）
    expect(statuses[statuses.length - 1]).toBe(true);
    expect(statuses.filter((value) => value).length).toBe(1);
  });

  it('接收端不存在（即断端口）时错误信息携带 chrome.runtime.lastError 原文', async () => {
    const client = connectPageTools(() => asPort(new StubPort({ dieImmediately: true })));

    // onDisconnect 监听器内已消费 lastError（否则 Chrome 打印 Unchecked 告警），
    // 并把失败原因并入拒绝信息，便于定位"页面未注入/受限页面"等场景
    await expect(client.listTools()).rejects.toThrow(
      `与页面工具桥接的连接已断开（${CONNECT_ERROR_MESSAGE}），将自动重连`
    );
    client.disconnect();
  });

  it('接收端不存在期间状态始终离线，不出现乐观在线', async () => {
    let created = 0;
    const client = connectPageTools(() => {
      created += 1;
      return asPort(new StubPort({ dieImmediately: true }));
    });

    const statuses: boolean[] = [];
    client.onStatusChange((value) => statuses.push(value));

    // 连续多轮重连全部失败：状态除订阅时的初始 false 外，不应出现 true
    await expect(client.listTools()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(created).toBeGreaterThanOrEqual(3);
    expect(statuses.every((value) => value === false)).toBe(true);
    client.disconnect();
  });

  it('探活超时（端口在但桥接无响应）也会继续退避重试', async () => {
    let created = 0;
    const client = connectPageTools(() => {
      created += 1;
      if (created === 1) {
        return asPort(new StubPort({ dieImmediately: true }));
      }
      // 端口存活但对请求从不响应（模拟 content script 已注入但 MCP 未就绪）
      return asPort(new StubPort());
    });

    await expect(client.listTools()).rejects.toThrow('与页面工具桥接的连接已断开');
    // 第 1 次重连：ping 发出但无响应 → 5s ping 超时 → 再排下一次
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000 + 2_000);
    // 第 2 次重连已发生（退避按 2s 排定）
    expect(created).toBe(3);
    client.disconnect();
  });

  it('disconnect() 后重连循环终止', async () => {
    let created = 0;
    const client = connectPageTools(() => {
      created += 1;
      return asPort(new StubPort({ dieImmediately: true }));
    });

    await expect(client.listTools()).rejects.toThrow();
    client.disconnect();
    const countAtDisconnect = created;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(created).toBe(countAtDisconnect);
  });
});
