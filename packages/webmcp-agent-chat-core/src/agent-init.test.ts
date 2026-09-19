// agent-init 载荷单源单测：脱敏矩阵（T1，红线锁死）+ 通道工具过滤（T2）+ 双路一致性根基。
import { describe, expect, it } from 'vitest';
import type { AgentA2aRef } from './a2a-config';
import {
  AGENT_CHANNEL_TOOL_NAMES,
  AGENT_DISCONNECT_TOOL_NAME,
  AGENT_INITIALIZATION_TOOL_NAME,
  buildAgentDisconnectPayload,
  buildAgentInitPayload,
  excludeAgentChannelTools,
  isAgentChannelTool,
  stripTabToolPrefix,
  type AgentInitSnapshot,
} from './agent-init';
import type { AgentProfile } from './agent-profile';

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'agent-1',
  name: '通用智能体',
  description: '默认智能体',
  rules: { inheritGlobal: true, items: [] },
  skills: [],
  mcps: [],
  ...overrides,
});

const a2aRef = (overrides: Partial<AgentA2aRef> = {}): AgentA2aRef => ({
  id: 'remote-agent',
  cardUrl: 'https://intranet.example.com/.well-known/agent-card.json',
  enabled: true,
  ...overrides,
});

const snapshot = (overrides: Partial<AgentInitSnapshot> = {}): AgentInitSnapshot => ({
  agents: [profile()],
  activeAgentId: 'agent-1',
  a2aRefs: [],
  skills: [],
  tools: [],
  ...overrides,
});

describe('buildAgentInitPayload 脱敏矩阵（T1）', () => {
  it('agents 仅暴露 id/name/description；rules 与 llmOverride 全文不入载荷', () => {
    const payload = buildAgentInitPayload(
      snapshot({
        agents: [
          profile({
            description: '含 <秘密> 的描述',
            rules: { inheritGlobal: false, items: [{ id: 'r1', text: '规则全文 SECRET-RULES' }] },
            skills: [{ id: 's1', enabled: true }],
            llmOverride: { baseUrl: 'http://secret-host', model: 'gpt-x' },
          }),
        ],
      }),
      1000
    );
    expect(payload.agents).toEqual([{ id: 'agent-1', name: '通用智能体', description: '含 <秘密> 的描述' }]);
    expect(JSON.stringify(payload)).not.toContain('SECRET-RULES');
    expect(JSON.stringify(payload)).not.toContain('secret-host');
    expect(JSON.stringify(payload)).not.toContain('gpt-x');
    expect(JSON.stringify(payload)).not.toContain('llmOverride');
  });

  it('a2aAgents 仅暴露 id/name/protocol/enabled；cardUrl/endpoint/inputs 不入载荷', () => {
    const payload = buildAgentInitPayload(
      snapshot({
        a2aRefs: [
          a2aRef({ displayName: '远端文档智能体' }),
          a2aRef({
            id: 'weather',
            protocol: 'dify',
            endpoint: 'https://api.dify.example.com/v1/chat-messages',
            inputs: { secret_input: 'x' },
          }),
        ],
      }),
      1000
    );
    expect(payload.a2aAgents).toEqual([
      { id: 'remote-agent', name: '远端文档智能体', protocol: 'jsonrpc', enabled: true },
      // displayName 缺省兜底 id（与 a2a-tool-source 工具清单同口径）
      { id: 'weather', name: 'weather', protocol: 'dify', enabled: true },
    ]);
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain('intranet.example.com');
    expect(raw).not.toContain('chat-messages');
    expect(raw).not.toContain('secret_input');
  });

  it('currentAgent = activeAgentId 命中档案；缺失或未知 id → null', () => {
    const hit = buildAgentInitPayload(snapshot(), 1000);
    expect(hit.currentAgent).toEqual({ id: 'agent-1', name: '通用智能体' });
    const none = buildAgentInitPayload(snapshot({ activeAgentId: null }), 1000);
    expect(none.currentAgent).toBeNull();
    const unknown = buildAgentInitPayload(snapshot({ activeAgentId: 'ghost' }), 1000);
    expect(unknown.currentAgent).toBeNull();
  });

  it('skills 仅暴露 id/name/description（keywords 不入载荷）', () => {
    const payload = buildAgentInitPayload(
      snapshot({
        skills: [{ id: 'k1', name: '翻译', description: '中英互译', keywords: ['translate'] }],
      }),
      1000
    );
    expect(payload.skills).toEqual([{ id: 'k1', name: '翻译', description: '中英互译' }]);
    expect(JSON.stringify(payload)).not.toContain('translate');
  });

  it('tools 不含通道工具本身（builder 兜底剔除：裸名与 tab<id>__ 前缀形态均命中）', () => {
    const payload = buildAgentInitPayload(
      snapshot({
        tools: [
          { name: AGENT_INITIALIZATION_TOOL_NAME, description: 'x', inputSchema: {} },
          { name: 'tab7__' + AGENT_INITIALIZATION_TOOL_NAME, description: 'y', inputSchema: {} },
          { name: 'tab7__' + AGENT_DISCONNECT_TOOL_NAME, description: 'z', inputSchema: {} },
          { name: 'get_status', description: 'ok', inputSchema: { type: 'object' } },
        ],
      }),
      1000
    );
    expect(payload.tools).toEqual([{ name: 'get_status', description: 'ok', inputSchema: { type: 'object' } }]);
  });

  it('同输入恒同输出（推送/拉取双路一致的结构性保证）', () => {
    const s = snapshot({
      agents: [profile(), profile({ id: 'a2', name: '调试' })],
      a2aRefs: [a2aRef()],
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(buildAgentInitPayload(s, 12345)).toEqual(buildAgentInitPayload(s, 12345));
  });
});

describe('通道工具判定与过滤（T2）', () => {
  it('AGENT_CHANNEL_TOOL_NAMES 恰含两个通道工具', () => {
    expect(AGENT_CHANNEL_TOOL_NAMES).toEqual([
      'web_mcp_agent_initialization',
      'web_mcp_agent_disconnect',
    ]);
  });

  it('stripTabToolPrefix：剥 tab<id>__ 前缀，无前缀原样返回', () => {
    expect(stripTabToolPrefix('tab12__get_status')).toBe('get_status');
    expect(stripTabToolPrefix('get_status')).toBe('get_status');
    expect(stripTabToolPrefix('tab__x')).toBe('tab__x'); // 无数字不算前缀
  });

  it('isAgentChannelTool：裸名 / tab 前缀命中，其他工具不命中', () => {
    for (const name of AGENT_CHANNEL_TOOL_NAMES) {
      expect(isAgentChannelTool(name)).toBe(true);
      expect(isAgentChannelTool(`tab3__${name}`)).toBe(true);
    }
    expect(isAgentChannelTool('get_status')).toBe(false);
    expect(isAgentChannelTool('tab3__get_status')).toBe(false);
    expect(isAgentChannelTool('web_mcp_agent_initialization_x')).toBe(false);
  });

  it('excludeAgentChannelTools 只剔除命中项，保持顺序与引用', () => {
    const tools = [
      { name: 'a', description: '1' },
      { name: 'tab1__web_mcp_agent_disconnect', description: '2' },
      { name: 'b', description: '3' },
    ];
    const filtered = excludeAgentChannelTools(tools);
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe(tools[0]);
    expect(filtered[1]).toBe(tools[2]);
  });
});

describe('buildAgentDisconnectPayload（C7 Q1）', () => {
  it('小载荷结构与 now 注入', () => {
    expect(buildAgentDisconnectPayload(1700000000000)).toEqual({
      version: 1,
      event: 'disconnect',
      occurredAt: 1700000000000,
    });
    const payload = buildAgentDisconnectPayload();
    expect(payload.event).toBe('disconnect');
    expect(typeof payload.occurredAt).toBe('number');
  });
});
