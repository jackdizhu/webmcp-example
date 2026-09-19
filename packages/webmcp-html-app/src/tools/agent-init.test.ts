import { describe, expect, it, vi } from 'vitest';
import { createAgentInitializationTool, isAgentInitPayload } from './agent-init';

const validPayload = {
  version: 1,
  pushedAt: 1_700_000_000_000,
  currentAgent: { id: 'a1', name: '通用智能体' },
  agents: [{ id: 'a1', name: '通用智能体', description: 'd' }],
  a2aAgents: [{ id: 'r1', name: '远端', protocol: 'jsonrpc', enabled: true }],
  skills: [{ id: 's1', name: '技能', description: 'g' }],
  tools: [{ name: 'get_status', description: 'Returns app status' }],
};

describe('createAgentInitializationTool', () => {
  it('工具元信息：协议工具名 + object schema', () => {
    const tool = createAgentInitializationTool({ onInitialization: () => {} });
    expect(tool.name).toBe('web_mcp_agent_initialization');
    expect(tool.inputSchema.type).toBe('object');
  });

  it('合法载荷 → handler 收到原对象，返回确认文本', async () => {
    const onInitialization = vi.fn();
    const tool = createAgentInitializationTool({ onInitialization });
    const result = await tool.execute(validPayload as unknown as Record<string, unknown>);
    expect(onInitialization).toHaveBeenCalledWith(validPayload);
    expect(result.content[0]?.text).toContain('已接收');
  });

  it('非法载荷（version 缺失 / agents 非数组）→ 抛错且 handler 不被调用', async () => {
    const onInitialization = vi.fn();
    const tool = createAgentInitializationTool({ onInitialization });
    await expect(tool.execute({ version: 2, agents: [], tools: [] })).rejects.toThrow('不合法');
    await expect(tool.execute({ version: 1 })).rejects.toThrow('不合法');
    await expect(tool.execute(null as unknown as Record<string, unknown>)).rejects.toThrow('不合法');
    expect(onInitialization).not.toHaveBeenCalled();
  });
});

describe('isAgentInitPayload', () => {
  it('version=1 且 agents/tools 数组在位才算合法', () => {
    expect(isAgentInitPayload(validPayload)).toBe(true);
    expect(isAgentInitPayload({ ...validPayload, version: 2 })).toBe(false);
    expect(isAgentInitPayload({ ...validPayload, tools: 'nope' })).toBe(false);
    expect(isAgentInitPayload('str')).toBe(false);
    expect(isAgentInitPayload(null)).toBe(false);
  });
});
