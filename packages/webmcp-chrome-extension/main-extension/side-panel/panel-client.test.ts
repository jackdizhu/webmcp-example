// panel-client 单测（2026-09-12 多页签编排改造）：
// 连接目标 = setTargetTabs 下发的全局选中页签集合；每页签一条 Port；
// listTools 合并 + 同名工具 tab<id>__ 前缀去歧义；callTool 按路由表投递；
// 断线重连按页签独立进行（不再监听 onActivated 自动跟随）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectPageTools, loadSettings, saveSettings } from './panel-client';
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
  private dropped = false;

  constructor(
    private readonly options: {
      /** 连接后立即异步触发 onDisconnect（模拟接收端不存在，与 Chrome 行为一致）。 */
      dieImmediately?: boolean;
      /** 对每个请求回 ok 响应（模拟已就绪的桥接）。 */
      responder?: (request: PageToolsRequest) => PageToolsResponse;
    } = {}
  ) {
    if (options.dieImmediately) {
      // macrotask 延迟断开：保证 client 侧 attachPort（microtask 注册监听）先行，
      // 与 Chrome「connect 后异步失败」语义一致；fake timers 下由 advanceTimers 驱动
      setTimeout(() => this.drop(CONNECT_ERROR_MESSAGE), 0);
    }
  }

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
      // Chrome 行为：无接收端时 onDisconnect 异步触发（构造时已排队，此处兜底）
      this.drop(CONNECT_ERROR_MESSAGE);
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

  /** 模拟对端推送任意消息（如 toolsChanged 通知）。 */
  emit(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }

  /** 模拟对端断开；lastErrorMessage 非空时模拟 Chrome 在监听器执行期间暴露 lastError。 */
  drop(lastErrorMessage?: string): void {
    if (this.dropped) return;
    this.dropped = true;
    setChromeLastError(lastErrorMessage);
    try {
      for (const fn of this.disconnectListeners) fn();
    } finally {
      setChromeLastError(undefined);
    }
  }
}

const asPort = (stub: StubPort): chrome.runtime.Port => stub as unknown as chrome.runtime.Port;

describe('connectPageTools 多页签编排', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('目标为空时离线且 listTools 返回空数组', async () => {
    const client = connectPageTools(() => asPort(new StubPort()));
    const statuses: boolean[] = [];
    client.onStatusChange((value) => statuses.push(value));
    await expect(client.listTools()).resolves.toEqual([]);
    expect(statuses.every((value) => value === false)).toBe(true);
    client.disconnect();
  });

  it('setTargetTabs 建连后聚合在线；listTools 合并多页签清单', async () => {
    const ports = new Map<number, StubPort>();
    const client = connectPageTools((tabId) => {
      const stub = new StubPort({
        responder: (request) => ({
          id: request.id,
          ok: true,
          result:
            request.type === 'listTools'
              ? [
                  { name: `tool_${tabId}`, description: `d${tabId}`, inputSchema: { type: 'object' } },
                ]
              : { tabId },
        }),
      });
      ports.set(tabId, stub);
      return asPort(stub);
    });

    const statuses: boolean[] = [];
    client.onStatusChange((value) => statuses.push(value));

    client.setTargetTabs([1]);
    // 建连是异步的：首条 listTools 响应到达后聚合在线
    await vi.advanceTimersByTimeAsync(0);
    await expect(client.listTools()).resolves.toEqual([
      { name: 'tool_1', description: 'd1', inputSchema: { type: 'object' } },
    ]);
    expect(statuses.at(-1)).toBe(true);

    // 追加第二个页签：清单合并
    client.setTargetTabs([1, 2]);
    await expect(client.listTools()).resolves.toEqual([
      { name: 'tool_1', description: 'd1', inputSchema: { type: 'object' } },
      { name: 'tool_2', description: 'd2', inputSchema: { type: 'object' } },
    ]);
    expect(ports.get(1)?.posted.length).toBeGreaterThan(0);
    expect(ports.get(2)?.posted.length).toBeGreaterThan(0);
    client.disconnect();
  });

  it('同名工具跨页签冲突：全部冲突实例加 tab<id>__ 前缀，callTool 按路由投递原始名', async () => {
    const calls: Array<{ tabId: number; name: string }> = [];
    const client = connectPageTools((tabId) =>
      asPort(
        new StubPort({
          responder: (request) => {
            if (request.type === 'listTools') {
              return {
                id: request.id,
                ok: true,
                result: [{ name: 'get_status', description: 'dup', inputSchema: { type: 'object' } }],
              };
            }
            calls.push({ tabId, name: request.name ?? '' });
            return { id: request.id, ok: true, result: { by: tabId } };
          },
        })
      )
    );

    client.setTargetTabs([1, 2]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(client.listTools()).resolves.toEqual([
      { name: 'tab1__get_status', description: 'dup', inputSchema: { type: 'object' } },
      { name: 'tab2__get_status', description: 'dup', inputSchema: { type: 'object' } },
    ]);

    await expect(client.callTool('tab2__get_status', { a: 1 })).resolves.toEqual({ by: 2 });
    expect(calls).toEqual([{ tabId: 2, name: 'get_status' }]);

    // 未知暴露名（未在路由表）抛错
    await expect(client.callTool('get_status', {})).rejects.toThrow('未知工具');
    client.disconnect();
  });

  it('唯一工具名跨页签不加前缀，callTool 路由到持有页签', async () => {
    const calls: Array<{ tabId: number; name: string }> = [];
    const client = connectPageTools((tabId) =>
      asPort(
        new StubPort({
          responder: (request) => {
            if (request.type === 'listTools') {
              return {
                id: request.id,
                ok: true,
                result: [{ name: `only_${tabId}`, description: 'd', inputSchema: { type: 'object' } }],
              };
            }
            calls.push({ tabId, name: request.name ?? '' });
            return { id: request.id, ok: true, result: null };
          },
        })
      )
    );

    client.setTargetTabs([1, 2]);
    await vi.advanceTimersByTimeAsync(0);
    await client.listTools();

    await client.callTool('only_2', {});
    expect(calls).toEqual([{ tabId: 2, name: 'only_2' }]);
    client.disconnect();
  });

  it('setTargetTabs 移除页签：Port 断开、路由失效（未知工具报错）', async () => {
    const ports = new Map<number, StubPort>();
    const client = connectPageTools((tabId) => {
      const stub = new StubPort({
        responder: (request) => ({
          id: request.id,
          ok: true,
          result:
            request.type === 'listTools'
              ? [{ name: `tool_${tabId}`, description: 'd', inputSchema: { type: 'object' } }]
              : null,
        }),
      });
      ports.set(tabId, stub);
      return asPort(stub);
    });

    client.setTargetTabs([1, 2]);
    await vi.advanceTimersByTimeAsync(0);
    await client.listTools();

    client.setTargetTabs([2]);
    expect(ports.get(1)?.posted).toBeDefined();
    // 移除后路由表中 tab1 的工具消失
    await expect(client.callTool('tool_1', {})).rejects.toThrow('未知工具');
    await expect(client.callTool('tool_2', {})).resolves.toBeDefined();
    client.disconnect();
  });

  it('部分页签离线不阻断其余页签工具；全部失败才抛错', async () => {
    const client = connectPageTools((tabId) => {
      if (tabId === 1) {
        // 页签 1：接收端不存在，端口即断（离线）
        return asPort(new StubPort({ dieImmediately: true }));
      }
      return asPort(
        new StubPort({
          responder: (request) => ({
            id: request.id,
            ok: true,
            result: request.type === 'listTools' ? [{ name: 'tool_2', description: 'd', inputSchema: {} }] : null,
          }),
        })
      );
    });

    client.setTargetTabs([1, 2]);
    await vi.advanceTimersByTimeAsync(0);
    // 页签 1 离线，页签 2 正常 → 合并结果仍可用
    await expect(client.listTools()).resolves.toEqual([
      { name: 'tool_2', description: 'd', inputSchema: {} },
    ]);
    client.disconnect();
  });

  it('即断端口：退避重连按页签独立恢复在线（1s 首次退避）', async () => {
    let createdForTab1 = 0;
    const client = connectPageTools((tabId) => {
      if (tabId === 1) {
        createdForTab1 += 1;
        if (createdForTab1 === 1) {
          return asPort(new StubPort({ dieImmediately: true }));
        }
      }
      return asPort(
        new StubPort({
          responder: (request) => ({ id: request.id, ok: true, result: request.type === 'listTools' ? [] : null }),
        })
      );
    });

    const statuses: boolean[] = [];
    client.onStatusChange((value) => statuses.push(value));

    client.setTargetTabs([1]);
    await vi.advanceTimersByTimeAsync(0); // 首个端口即断 → 排 1s 退避
    await vi.advanceTimersByTimeAsync(1_000); // 重连：第二个端口探活成功
    expect(createdForTab1).toBe(2);
    expect(statuses.at(-1)).toBe(true);

    // 恢复在线后 listTools 可用
    await expect(client.listTools()).resolves.toEqual([]);
    client.disconnect();
  });

  it('disconnect() 后重连循环终止且不再建连', async () => {
    let created = 0;
    const client = connectPageTools(() => {
      created += 1;
      return asPort(new StubPort({ dieImmediately: true }));
    });

    client.setTargetTabs([1]);
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect();
    const countAtDisconnect = created;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(created).toBe(countAtDisconnect);
  });

  it('toolsChanged 通知触发 onToolsChange 订阅且不影响挂起请求', async () => {
    const stub = new StubPort({
      responder: (request) => ({ id: request.id, ok: true, result: [] }),
    });
    const client = connectPageTools(() => asPort(stub));
    client.setTargetTabs([1]);

    let fired = 0;
    client.onToolsChange(() => {
      fired += 1;
    });

    await client.listTools();
    expect(fired).toBe(0);

    stub.emit({ type: 'toolsChanged' });
    expect(fired).toBe(1);
    await expect(client.listTools()).resolves.toEqual([]);
    client.disconnect();
  });

  it('默认工厂经 chrome.tabs.connect 直连指定页签（不查询活动页签）', async () => {
    const stub = new StubPort({
      responder: (request) => ({ id: request.id, ok: true, result: [] }),
    });
    const querySpy = vi.fn(async () => [{ id: 42 }]);
    const connectSpy = vi.fn(() => stub);
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      runtime: {},
      tabs: { query: querySpy, connect: connectSpy },
    };

    const client = connectPageTools();
    client.setTargetTabs([7]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(client.listTools()).resolves.toEqual([]);
    // R2/R3 决策：目标页签由调用方给定，不再经 tabs.query 取活动页签
    expect(querySpy).not.toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalledWith(7, { name: 'webmcp-page-tools' });

    client.disconnect();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });
});

describe('loadSettings / saveSettings', () => {
  const makeStorage = (initial: Record<string, unknown> = {}) => {
    const data: Record<string, unknown> = { ...initial };
    return {
      get: async (keys?: string | string[] | null) => {
        if (keys === null || keys === undefined) return { ...data };
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const key of list) if (key in data) out[key] = data[key];
        return out;
      },
      set: async (patch: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(patch)) data[key] = value;
      },
    };
  };

  it('缺省时回退内置默认（含 systemPrompt 与 maxHistoryTurns）', async () => {
    const storage = makeStorage();
    const settings = await loadSettings(storage);
    expect(settings.systemPrompt).toBe(
      '你是浏览器页面 WebMCP 工具验证助手。用户会要求你验证当前页面暴露的工具；' +
        '请优先调用页面工具并基于真实返回结果回答，不要编造工具执行结果。'
    );
    expect(settings.maxHistoryTurns).toBe(5);
    expect(settings.apiProtocol).toBe('openai-compat');
    expect(settings.maxTokens).toBe(4096);
  });

  it('systemPrompt 缺失/非字符串回退默认；maxHistoryTurns 非整数回退默认', async () => {
    const storage = makeStorage({
      llmSystemPrompt: 123,
      agentMaxHistoryTurns: 'not-a-number',
    });
    const settings = await loadSettings(storage);
    expect(settings.systemPrompt).toBe(
      '你是浏览器页面 WebMCP 工具验证助手。用户会要求你验证当前页面暴露的工具；' +
        '请优先调用页面工具并基于真实返回结果回答，不要编造工具执行结果。'
    );
    expect(settings.maxHistoryTurns).toBe(5);
  });

  it('apiPath 缺省回退默认路径；显式空串保留（表示清空，不回退）', async () => {
    // 存量配置无 llmApiPath 键 → 回退默认
    const fallback = await loadSettings(makeStorage());
    expect(fallback.apiPath).toBe('/chat/completions');
    // 显式存了空串 → 保留空串语义
    const cleared = await loadSettings(makeStorage({ llmApiPath: '' }));
    expect(cleared.apiPath).toBe('');
  });

  it('apiProtocol 仅接受合法枚举，其余回退 openai-compat', async () => {
    const valid = await loadSettings(makeStorage({ llmApiProtocol: 'anthropic' }));
    expect(valid.apiProtocol).toBe('anthropic');
    const invalid = await loadSettings(makeStorage({ llmApiProtocol: 'gemini' }));
    expect(invalid.apiProtocol).toBe('openai-compat');
  });

  it('保存后读取往返一致（含新增 apiProtocol / maxTokens）', async () => {
    const storage = makeStorage();
    await saveSettings(
      {
        apiKey: 'sk-x',
        baseUrl: 'https://example.com/v1',
        apiPath: '/v1/chat/completions',
        model: 'm',
        apiProtocol: 'anthropic',
        maxTokens: 2048,
        debugMode: true,
        consoleOutput: true,
        systemPrompt: '自定义提示词',
        maxHistoryTurns: 3,
      },
      storage
    );
    const settings = await loadSettings(storage);
    expect(settings.apiPath).toBe('/v1/chat/completions');
    expect(settings.systemPrompt).toBe('自定义提示词');
    expect(settings.maxHistoryTurns).toBe(3);
    expect(settings.apiProtocol).toBe('anthropic');
    expect(settings.maxTokens).toBe(2048);
  });
});
