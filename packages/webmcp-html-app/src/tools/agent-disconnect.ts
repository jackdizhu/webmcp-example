// 宿主关闭通知接收工具（C7 的页面侧落点）。
//
// 侧栏宿主不可用时（SW 广播主路径 / CS 自检增强路径汇合），扩展经页面工具通道
// callTool `web_mcp_agent_disconnect`（页签裸名）推送断连事件；本工具校验后交由
// 注入的 handler 广播（main.ts 转 window CustomEvent，联调面板与应用订阅消费）。
//
// 类型契约：本地镜像最小载荷类型，**唯一事实源 =
// packages/webmcp-agent-chat-core/src/agent-init.ts 的 AgentDisconnectPayload**，
// 协议改动时双向同步（镜像约定见 agent-task-test.ts）。

/** 断连事件载荷（AgentDisconnectPayload 的本地镜像）。 */
export interface AgentDisconnectPayloadMirror {
  version: number;
  event: 'disconnect';
  occurredAt: number;
}

export interface AgentDisconnectToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

export interface AgentDisconnectTool {
  name: 'web_mcp_agent_disconnect';
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, never> };
  /** 入参为 polyfill 宽类型（WebMcpToolInput 兼容形态）；合法性由 isAgentDisconnectPayload 守卫。 */
  execute: (args: unknown) => Promise<AgentDisconnectToolResult>;
}

/** 载荷最小校验：version=1 + event='disconnect' + occurredAt 数值。 */
export function isAgentDisconnectPayload(value: unknown): value is AgentDisconnectPayloadMirror {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    record['event'] === 'disconnect' &&
    typeof record['occurredAt'] === 'number'
  );
}

/**
 * 构造宿主关闭通知接收工具。onDisconnect 在校验通过后被调用
 * （同步；异常会作为工具执行错误返回给扩展侧，扩展侧仅记日志不重试）。
 */
export function createAgentDisconnectTool(handlers: {
  onDisconnect: (payload: AgentDisconnectPayloadMirror) => void;
}): AgentDisconnectTool {
  return {
    name: 'web_mcp_agent_disconnect',
    description: '接收侧栏宿主不可用的断连通知',
    inputSchema: { type: 'object', properties: {} },
    execute: async (args: unknown) => {
      if (!isAgentDisconnectPayload(args)) {
        throw new Error('断连载荷不合法：version 必须为 1、event 必须为 disconnect');
      }
      handlers.onDisconnect(args);
      return {
        content: [{ type: 'text', text: '断连通知已接收' }],
      };
    },
  };
}
