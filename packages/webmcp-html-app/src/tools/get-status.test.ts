import { describe, expect, it } from 'vitest';
import { createGetStatusTool } from './get-status';

describe('createGetStatusTool', () => {
  it('返回名为 get_status 的工具元信息', () => {
    const tool = createGetStatusTool();
    expect(tool.name).toBe('get_status');
    expect(tool.description).toBe('Returns app status');
    expect(tool.inputSchema.type).toBe('object');
  });

  it('execute 返回应用运行态结果', async () => {
    const tool = createGetStatusTool();
    const result = await tool.execute();
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toBe('Vanilla app is running');
  });
});
