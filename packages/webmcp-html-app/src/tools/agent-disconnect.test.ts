import { describe, expect, it, vi } from 'vitest';
import { createAgentDisconnectTool, isAgentDisconnectPayload } from './agent-disconnect';

const validPayload = { version: 1, event: 'disconnect', occurredAt: 1_700_000_000_000 };

describe('createAgentDisconnectTool', () => {
  it('工具元信息：协议工具名 + object schema', () => {
    const tool = createAgentDisconnectTool({ onDisconnect: () => {} });
    expect(tool.name).toBe('web_mcp_agent_disconnect');
    expect(tool.inputSchema.type).toBe('object');
  });

  it('合法载荷 → handler 收到原对象，返回确认文本', async () => {
    const onDisconnect = vi.fn();
    const tool = createAgentDisconnectTool({ onDisconnect });
    const result = await tool.execute(validPayload as unknown as Record<string, unknown>);
    expect(onDisconnect).toHaveBeenCalledWith(validPayload);
    expect(result.content[0]?.text).toContain('已接收');
  });

  it('非法载荷 → 抛错且 handler 不被调用', async () => {
    const onDisconnect = vi.fn();
    const tool = createAgentDisconnectTool({ onDisconnect });
    await expect(tool.execute({ version: 1, event: 'other', occurredAt: 1 })).rejects.toThrow('不合法');
    await expect(tool.execute({ version: 1, event: 'disconnect' })).rejects.toThrow('不合法');
    await expect(tool.execute(undefined as unknown as Record<string, unknown>)).rejects.toThrow('不合法');
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});

describe('isAgentDisconnectPayload', () => {
  it('version=1 + event=disconnect + occurredAt 数值才算合法', () => {
    expect(isAgentDisconnectPayload(validPayload)).toBe(true);
    expect(isAgentDisconnectPayload({ ...validPayload, occurredAt: 'x' })).toBe(false);
    expect(isAgentDisconnectPayload({ version: 1, occurredAt: 1 })).toBe(false);
    expect(isAgentDisconnectPayload(42)).toBe(false);
  });
});
