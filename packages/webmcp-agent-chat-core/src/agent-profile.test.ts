// agent-profile 领域模块单测：校验 / 组装 / 合并 / 取活跃 / 迁移幂等。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTIVE_AGENT_ID,
  LEGACY_DEFAULT_AGENT_ID,
  composeSystemPrompt,
  createBuiltinAgentProfiles,
  getActiveAgent,
  mergeLlmConfig,
  migrateLegacySettings,
  validateAgentProfilesState,
  type AgentProfile,
  type AgentProfilesState,
  type AgentRules,
  type AgentSkillRef,
  type AgentA2aRef,
} from './agent-profile';
import type { LlmConfig } from './llm-client';

const agent = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'page-qa',
  name: '页面问答助手',
  description: 'desc',
  rules: { inheritGlobal: true, items: [{ id: 'r1', text: '优先调用页面工具。' }] },
  skills: [],
  mcps: [],
  a2aAgents: [],
  ...overrides,
});

const baseConfig: LlmConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiProtocol: 'openai-compat',
  maxTokens: 4096,
};

/** 非法技能引用（enabled 非布尔）：经 unknown 断言绕过编译期检查，验证运行时校验。 */
const badSkillRef = { id: 's', enabled: 'x' } as unknown as AgentSkillRef;
/** 非法 A2A 引用（enabled 非布尔）：同上。 */
const badA2aRef = { id: 'd', cardUrl: 'https://x.example.com/card.json', enabled: 1 } as unknown as AgentA2aRef;
/** 非法 rules（inheritGlobal 非布尔）：同上。 */
const badRules = { inheritGlobal: 'yes', items: [] } as unknown as AgentRules;

describe('composeSystemPrompt', () => {
  it('activeAgent 为 null 时原样返回全局提示词（兼容存量行为）', () => {
    expect(composeSystemPrompt(null, '  全局提示  ')).toBe('全局提示');
  });

  it('inheritGlobal + agent 规则时输出 global 段与 agent 段（带来源标注）', () => {
    const prompt = composeSystemPrompt(agent(), '全局提示');
    expect(prompt).toBe('[rules:global]\n全局提示\n\n[rules:agent:page-qa:r1]\n优先调用页面工具。');
  });

  it('inheritGlobal 为 false 时跳过 global 段', () => {
    const prompt = composeSystemPrompt(
      agent({ rules: { inheritGlobal: false, items: [{ id: 'r1', text: '只按 agent 规则。' }] } }),
      '全局提示'
    );
    expect(prompt).toBe('[rules:agent:page-qa:r1]\n只按 agent 规则。');
  });

  it('空 global 提示词时省略 global 段', () => {
    const prompt = composeSystemPrompt(agent(), '   ');
    expect(prompt).toBe('[rules:agent:page-qa:r1]\n优先调用页面工具。');
  });

  it('全部为空时返回空串（调用方回落内置默认提示）', () => {
    expect(
      composeSystemPrompt(agent({ rules: { inheritGlobal: true, items: [] } }), '')
    ).toBe('');
  });

  it('多条 agent 规则逐条成段，空文本条目跳过', () => {
    const prompt = composeSystemPrompt(
      agent({
        rules: {
          inheritGlobal: false,
          items: [
            { id: 'r1', text: '第一条' },
            { id: 'r2', text: '   ' },
            { id: 'r3', text: '第二条' },
          ],
        },
      }),
      ''
    );
    expect(prompt).toBe('[rules:agent:page-qa:r1]\n第一条\n\n[rules:agent:page-qa:r3]\n第二条');
  });
});

describe('mergeLlmConfig', () => {
  it('无覆写时原样返回 base', () => {
    expect(mergeLlmConfig(baseConfig)).toEqual(baseConfig);
  });

  it('仅应用合法的覆写字段，其余回落全局', () => {
    const merged = mergeLlmConfig(baseConfig, {
      model: 'other-model',
      maxTokens: 8192,
      baseUrl: '  ',
      apiProtocol: 'anthropic',
    });
    expect(merged).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'other-model',
      apiProtocol: 'anthropic',
      maxTokens: 8192,
    });
  });

  it('非法覆写值（空串 / 非正整数 / 未知协议）全部忽略', () => {
    const badOverride = { model: '', maxTokens: 0, apiProtocol: 'unknown' } as unknown as Parameters<
      typeof mergeLlmConfig
    >[1];
    const merged = mergeLlmConfig(baseConfig, badOverride);
    expect(merged).toEqual(baseConfig);
  });

  it('apiKey 不在覆写白名单内，始终保留全局值', () => {
    const badOverride = { apiKey: 'sk-evil' } as unknown as Parameters<typeof mergeLlmConfig>[1];
    const merged = mergeLlmConfig(baseConfig, badOverride);
    expect(merged.apiKey).toBe('sk-test');
  });
});

describe('createBuiltinAgentProfiles', () => {
  it('内置三智能体：单个tools调试（默认激活）+ 多轮循环智能体 + A2A智能体', () => {
    const profiles = createBuiltinAgentProfiles();
    expect(profiles.map((item) => item.id)).toEqual(['tool-debug', 'multi-turn-loop', 'a2a-analyst']);
    expect(profiles.map((item) => item.name)).toEqual(['单个tools调试', '多轮循环智能体', 'A2A智能体']);
  });

  it('A2A智能体：继承全局且规则要求分析优先调用 a2a__ 工具', () => {
    const a2aAgent = createBuiltinAgentProfiles().find((item) => item.id === 'a2a-analyst');
    expect(a2aAgent).toBeDefined();
    expect(a2aAgent!.rules.inheritGlobal).toBe(true);
    expect(a2aAgent!.rules.items[0]!.id).toBe('a2a-first-analysis');
    expect(a2aAgent!.rules.items[0]!.text).toContain('a2a__<id>__send_task');
    expect(a2aAgent!.rules.items[0]!.text).toContain('优先调用');
    expect(a2aAgent!.rules.items[0]!.text).toContain('tab<id>__');
  });

  it('单个tools调试不继承全局自带单工具约束；多轮循环智能体继承全局并带计划/异常停止规则', () => {
    const [toolDebug, multiTurn] = createBuiltinAgentProfiles();
    expect(toolDebug!.rules.inheritGlobal).toBe(false);
    expect(toolDebug!.rules.items[0]!.id).toBe('single-tool-per-turn');
    expect(multiTurn!.rules.inheritGlobal).toBe(true);
    expect(multiTurn!.rules.items.map((item) => item.id)).toEqual(['plan-first', 'stop-on-anomaly']);
    expect(multiTurn!.rules.items[0]!.text).toContain('先列出完整计划');
    expect(multiTurn!.rules.items[1]!.text).toContain('必须立即停止');
    expect(multiTurn!.skills).toEqual([{ id: 'page-tools-guide', enabled: true }]);
  });

  it('工厂每次返回全新对象（调用方互不共享可变引用）', () => {
    const a = createBuiltinAgentProfiles();
    const b = createBuiltinAgentProfiles();
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe('migrateLegacySettings', () => {
  it('existing 为空时创建内置三智能体，默认激活「单个tools调试」', () => {
    const state = migrateLegacySettings({ systemPrompt: '旧提示' }, null);
    expect(state.agents).toHaveLength(3);
    expect(state.activeAgentId).toBe(DEFAULT_ACTIVE_AGENT_ID);
    expect(state.agents[0]!.id).toBe('tool-debug');
  });

  it('旧版未定制默认智能体（仅一个 id=default 空规则）→ 升级为内置智能体全集', () => {
    const legacyState: AgentProfilesState = {
      agents: [
        {
          id: LEGACY_DEFAULT_AGENT_ID,
          name: '默认智能体',
          description: '由旧版系统提示词迁移（全局 rules 语义保留）',
          rules: { inheritGlobal: true, items: [] },
          skills: [],
          mcps: [],
          a2aAgents: [],
        },
      ],
      activeAgentId: LEGACY_DEFAULT_AGENT_ID,
    };
    const state = migrateLegacySettings({ systemPrompt: '旧提示' }, legacyState);
    expect(state.agents.map((item) => item.id)).toEqual(['tool-debug', 'multi-turn-loop', 'a2a-analyst']);
    expect(state.activeAgentId).toBe(DEFAULT_ACTIVE_AGENT_ID);
  });

  it('幂等：升级后的内置状态不再被改写', () => {
    const upgraded = migrateLegacySettings({ systemPrompt: '旧提示' }, null);
    expect(migrateLegacySettings({ systemPrompt: '旧提示' }, upgraded)).toBe(upgraded);
  });

  it('v5.1 存量内置状态（多轮循环 items 为空）→ 原位刷新补 rules，激活与自定义条目保留', () => {
    const [currentToolDebug] = createBuiltinAgentProfiles();
    const v51State: AgentProfilesState = {
      agents: [
        { ...currentToolDebug! },
        {
          id: 'multi-turn-loop',
          name: '多轮循环智能体',
          description: '完整工具集，支持多轮循环调用工具直至完成任务',
          rules: { inheritGlobal: true, items: [] },
          skills: [{ id: 'page-tools-guide', enabled: true }],
          mcps: [],
          a2aAgents: [],
        },
        agent({ id: 'my-custom', name: '我的自定义' }),
      ],
      activeAgentId: 'my-custom',
    };
    const state = migrateLegacySettings({ systemPrompt: '旧提示' }, v51State);
    expect(state).not.toBe(v51State);
    expect(state.activeAgentId).toBe('my-custom');
    // 原位刷新 multi-turn-loop 的 rules + 追加缺失的 a2a-analyst
    expect(state.agents).toHaveLength(4);
    const multiTurn = state.agents.find((item) => item.id === 'multi-turn-loop');
    expect(multiTurn!.rules.items.map((item) => item.id)).toEqual(['plan-first', 'stop-on-anomaly']);
    expect(state.agents.find((item) => item.id === 'my-custom')).toBeDefined();
    expect(state.agents.find((item) => item.id === 'a2a-analyst')).toBeDefined();
    expect(JSON.stringify(state.agents.find((item) => item.id === 'tool-debug'))).toBe(JSON.stringify(currentToolDebug));
  });

  it('存量档案缺失新增内置智能体时追加下发（用户数据与自定义条目不动）', () => {
    const [toolDebugOnly] = [createBuiltinAgentProfiles()[0]!];
    const state = migrateLegacySettings(
      { systemPrompt: '' },
      { agents: [{ ...toolDebugOnly }], activeAgentId: 'tool-debug' }
    );
    // 缺失的 multi-turn-loop 与 a2a-analyst 追加到末尾，已有条目原样保留
    expect(state.agents.map((item) => item.id)).toEqual(['tool-debug', 'multi-turn-loop', 'a2a-analyst']);
    expect(JSON.stringify(state.agents[0])).toBe(JSON.stringify(toolDebugOnly));
    expect(state.activeAgentId).toBe('tool-debug');
  });

  it('幂等：缺失内置条目补齐后再迁移原样返回（引用恒等）', () => {
    const state = migrateLegacySettings(
      { systemPrompt: '' },
      { agents: [{ ...createBuiltinAgentProfiles()[0]! }], activeAgentId: 'tool-debug' }
    );
    expect(migrateLegacySettings({ systemPrompt: '' }, state)).toBe(state);
  });

  it('幂等：用户已定制（全部内置条目齐备 + 自定义）时原样返回，不覆盖', () => {
    const existing: AgentProfilesState = {
      agents: [agent(), ...createBuiltinAgentProfiles()],
      activeAgentId: 'page-qa',
    };
    expect(migrateLegacySettings({ systemPrompt: '旧提示' }, existing)).toBe(existing);
  });

  it('内置条目上的用户数据在原位刷新时保留（a2aAgents / llmOverride 不被清空）', () => {
    const [toolDebug] = createBuiltinAgentProfiles();
    const a2aRefs = [{ id: 'dify_app', cardUrl: 'http://localhost/a/card.json', enabled: true, endpointOverride: 'http://localhost/e/app/a2a' }];
    const existing: AgentProfilesState = {
      agents: [
        {
          ...toolDebug!,
          a2aAgents: a2aRefs,
          llmOverride: { model: 'my-model' },
        },
      ],
      activeAgentId: 'tool-debug',
    };
    const state = migrateLegacySettings({ systemPrompt: '' }, existing);
    const refreshed = state.agents.find((item) => item.id === 'tool-debug');
    expect(refreshed).toBeDefined();
    expect(refreshed!.a2aAgents).toEqual(a2aRefs);
    expect(refreshed!.llmOverride).toEqual({ model: 'my-model' });
  });

  it('幂等：托管字段相同时刷新不触发（即使带用户数据）', () => {
    const existing: AgentProfilesState = {
      agents: createBuiltinAgentProfiles().map((builtin) =>
        builtin.id === 'tool-debug'
          ? { ...builtin, a2aAgents: [{ id: 'x', cardUrl: 'https://x/card.json', enabled: false }] }
          : builtin
      ),
      activeAgentId: 'tool-debug',
    };
    expect(migrateLegacySettings({ systemPrompt: '' }, existing)).toBe(existing);
  });

  it('existing.agents 为空数组时仍走重建路径', () => {
    const state = migrateLegacySettings({ systemPrompt: '' }, { agents: [], activeAgentId: '' });
    expect(state.agents).toHaveLength(3);
    expect(state.activeAgentId).toBe(DEFAULT_ACTIVE_AGENT_ID);
  });
});

describe('getActiveAgent', () => {
  it('按 activeAgentId 命中', () => {
    const state: AgentProfilesState = { agents: [agent(), agent({ id: 'b' })], activeAgentId: 'b' };
    expect(getActiveAgent(state)?.id).toBe('b');
  });

  it('activeAgentId 未命中时回落第一个', () => {
    const state: AgentProfilesState = { agents: [agent(), agent({ id: 'b' })], activeAgentId: 'missing' };
    expect(getActiveAgent(state)?.id).toBe('page-qa');
  });

  it('空列表返回 null', () => {
    expect(getActiveAgent({ agents: [], activeAgentId: '' })).toBeNull();
  });
});

describe('validateAgentProfilesState', () => {
  it('合法状态通过并原样返回', () => {
    const state: AgentProfilesState = {
      agents: [agent({ skills: [{ id: 'form-fill', enabled: true }], llmOverride: { model: 'm' } })],
      activeAgentId: 'page-qa',
    };
    expect(validateAgentProfilesState(structuredClone(state))).toEqual(state);
  });

  it.each([
    ['root 非对象', null, 'root'],
    ['agents 缺失', { activeAgentId: 'a' }, 'agents'],
    ['agent.id 为空串', { agents: [{ ...agent(), id: '' }], activeAgentId: 'a' }, 'agent.id'],
    ['rules.inheritGlobal 非布尔', { agents: [agent({ rules: badRules })], activeAgentId: 'a' }, 'inheritGlobal'],
    ['skills 条目非法', { agents: [agent({ skills: [badSkillRef] })], activeAgentId: 'a' }, 'skills'],
    ['a2aAgents 条目非法', { agents: [agent({ a2aAgents: [badA2aRef] })], activeAgentId: 'a' }, 'a2aAgents'],
  ])('非法状态 %s 抛错（含 %s）', (_label, value, reason) => {
    expect(() => validateAgentProfilesState(value)).toThrow(new RegExp(reason));
  });

  it('a2aAgents 合法引用通过校验；内置档案默认带空 a2aAgents', () => {
    const state: AgentProfilesState = {
      agents: [agent({ a2aAgents: [{ id: 'doc', cardUrl: 'https://a2a.example.com/card.json', enabled: true }] })],
      activeAgentId: 'page-qa',
    };
    expect(validateAgentProfilesState(structuredClone(state))).toEqual(state);
    for (const builtin of createBuiltinAgentProfiles()) {
      expect(builtin.a2aAgents).toEqual([]);
    }
  });
});
