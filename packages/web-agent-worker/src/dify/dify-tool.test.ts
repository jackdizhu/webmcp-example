// dify-tool 单测：工具名/描述/入参校验/结果文本化/续传。
import { describe, expect, it, vi } from 'vitest';
import { buildDifyChatTool, buildDifyChatToolName, requireDifyToolId } from './dify-tool';
import type { DifyClient } from './dify-client';

const toolConfig = {
  id: 'sales-agent',
  displayName: '销售助手',
  description: '查订单',
  endpoint: 'https://dify.example.test/v1/chat-messages',
  apiKey: 'app-x',
  user: 'u-1',
  inputs: { channel: 'web' },
};

describe('buildDifyChatTool', () => {
  it('工具名遵循 dify__<id>__chat 命名空间', () => {
    expect(buildDifyChatToolName('sales-agent')).toBe('dify__sales-agent__chat');
    expect(() => requireDifyToolId('bad id!')).toThrow();
  });

  it('工具描述含展示名与续传语义；入参 schema 要求 message 必填', () => {
    const { tool } = buildDifyChatTool(toolConfig, { client: {} as DifyClient });
    expect(tool.name).toBe('dify__sales-agent__chat');
    expect(tool.description).toContain('销售助手');
    expect(tool.description).toContain('conversationId');
    const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['message']);
    expect(schema.properties['taskId']).toBeDefined();
  });

  it('description 缺省用占位文案', () => {
    const { tool } = buildDifyChatTool({ ...toolConfig, displayName: undefined, description: undefined }, { client: {} as DifyClient });
    expect(tool.description).toContain('（无描述）');
  });

  it('execute 结果文本化：answer + conversationId + 续传提示', async () => {
    const chat = vi.fn(async () => ({ answer: '订单 A001 已发货', conversationId: 'conv-9' }));
    const { execute } = buildDifyChatTool(toolConfig, { client: { chat } as unknown as DifyClient });
    const text = (await execute({ message: '查订单', taskId: 'conv-9' })) as string;
    expect(text).toContain('订单 A001 已发货');
    expect(text).toContain('conversationId: conv-9');
    expect(text).toContain('taskId: conv-9');
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ query: '查订单', conversationId: 'conv-9', inputs: { channel: 'web' } }),
      { token: 'app-x' }
    );
  });

  it('message 缺失 / taskId 空串 → 抛错（loop 文本化回填）', async () => {
    const { execute } = buildDifyChatTool(toolConfig, { client: {} as DifyClient });
    await expect(execute({})).rejects.toThrow('message');
    await expect(execute({ message: 'x', taskId: '' })).rejects.toThrow('taskId');
  });
});
