/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectWebMCPClient } from './content-script';

// 用最小桩替换浏览器插件传输层，验证 content-script 的接线逻辑（不依赖真实扩展运行时）。
vi.mock('@mcp-b/transports', () => ({
  TabClientTransport: class {
    public options: { targetOrigin: string };
    constructor(options: { targetOrigin: string }) {
      this.options = options;
    }
    async start(): Promise<void> {}
    async close(): Promise<void> {}
  },
}));

const connectSpy = vi.fn();
vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    constructor(
      public info: unknown,
      public options: unknown,
    ) {}
    async connect(transport: unknown): Promise<void> {
      connectSpy(transport);
    }
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('connectWebMCPClient', () => {
  it('构造 MCP Client 并连接到当前页面', async () => {
    const client = await connectWebMCPClient();
    expect(client).toBeDefined();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('默认以当前页面源作为传输目标', async () => {
    await connectWebMCPClient();
    const transport = connectSpy.mock.calls[0]?.[0] as { options?: { targetOrigin: string } };
    expect(transport?.options?.targetOrigin).toBe(window.location.origin);
  });

  it('透传调用方传入的 client 元信息', async () => {
    const clientInfo = { name: 'test-client', version: '9.9.9' };
    await connectWebMCPClient(clientInfo);
    const created = vi.mocked(connectSpy).mock.calls[0];
    expect(created).toBeDefined();
  });
});
