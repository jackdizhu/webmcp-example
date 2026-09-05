// 暴露给 AI 代理的「应用状态」工具。
// 单独抽离为纯函数，便于单元测试，也符合「函数单一职责」的编码规范。

export interface StatusToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

export interface GetStatusTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, never> };
  execute: () => Promise<StatusToolResult>;
}

/** 构造一个返回应用运行状态的 WebMCP 工具定义。 */
export function createGetStatusTool(): GetStatusTool {
  return {
    name: 'get_status',
    description: 'Returns app status',
    inputSchema: { type: 'object', properties: {} },
    execute: async (): Promise<StatusToolResult> => ({
      content: [{ type: 'text', text: 'Vanilla app is running' }],
    }),
  };
}
