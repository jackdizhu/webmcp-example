// 初始化数据接收工具（C6 推送路径的页面侧落点）。
//
// 侧栏宿主在相关状态变化（agent 档案 / A2A / 技能 / 工具清单）后，经页面工具
// 通道 callTool `tab<id>__web_mcp_agent_initialization` 推送最新初始化载荷；
// 本工具做最小校验后交由注入的 handler 广播（main.ts 转 window CustomEvent，
// 联调面板与应用代码订阅消费）。该工具是协议面工具：扩展侧不会把它放进
// LLM 工具清单（agent 面双清单过滤），仅供宿主推送使用。
//
// 类型契约：本地镜像最小载荷类型，**唯一事实源 =
// packages/webmcp-agent-chat-core/src/agent-init.ts 的 AgentInitPayload**，
// 协议改动时双向同步（html-app 不依赖 chat-core，镜像约定见 agent-task-test.ts）。

/** 初始化载荷（AgentInitPayload 的本地镜像）。 */
export interface AgentInitPayloadMirror {
  version: number;
  pushedAt: number;
  currentAgent: { id: string; name: string } | null;
  agents: Array<{ id: string; name: string; description: string }>;
  a2aAgents: Array<{ id: string; name: string; protocol: string; enabled: boolean }>;
  skills: Array<{ id: string; name: string; description: string }>;
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>;
}

export interface AgentInitToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

export interface AgentInitializationTool {
  name: 'web_mcp_agent_initialization';
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, never> };
  /** 入参为 polyfill 宽类型（WebMcpToolInput 兼容形态）；合法性由 isAgentInitPayload 守卫。 */
  execute: (args: unknown) => Promise<AgentInitToolResult>;
}

/** 载荷最小校验：version=1 且 agents/tools 数组在位（深度字段由消费方自行判读）。 */
export function isAgentInitPayload(value: unknown): value is AgentInitPayloadMirror {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    Array.isArray(record['agents']) &&
    Array.isArray(record['tools'])
  );
}

/**
 * 构造初始化数据接收工具。onInitialization 在校验通过后被调用
 * （同步；异常会作为工具执行错误返回给宿主）。
 */
export function createAgentInitializationTool(handlers: {
  onInitialization: (payload: AgentInitPayloadMirror) => void;
}): AgentInitializationTool {
  return {
    name: 'web_mcp_agent_initialization',
    description: '接收侧栏推送的最新初始化数据（智能体/A2A/技能/工具清单快照）',
    inputSchema: { type: 'object', properties: {} },
    execute: async (args: unknown) => {
      if (!isAgentInitPayload(args)) {
        throw new Error('初始化载荷不合法：version 必须为 1 且 agents/tools 必须为数组');
      }
      handlers.onInitialization(args);
      return {
        content: [{ type: 'text', text: '初始化数据已接收' }],
      };
    },
  };
}
