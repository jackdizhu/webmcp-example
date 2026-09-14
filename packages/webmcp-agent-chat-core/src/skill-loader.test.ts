// skill-loader 领域模块单测：Token 估算 / L1 清单 / 工具定义与结果 / 解析编排 / 关键词预触发。
import { describe, expect, it } from 'vitest';
import {
  SKILL_L1_TOKEN_BUDGET,
  SKILL_TOOL_NAME,
  buildSkillL1Section,
  createSkillResolver,
  createSkillToolDefinition,
  estimateTokens,
  matchSkillTriggers,
  parseSkillToolArgs,
  toSkillToolError,
  toSkillToolResult,
  type SkillDefinition,
  type SkillSummary,
} from './skill-loader';
import { composeSystemPrompt, type AgentProfile } from './agent-profile';

const summary = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: 'form-fill',
  name: '表单填写助手',
  description: '如何在页面中定位并填写表单字段的实践指南',
  ...overrides,
});

const definition = (overrides: Partial<SkillDefinition> = {}): SkillDefinition => ({
  ...summary(),
  content: '# 步骤\n1. 定位输入框\n2. 逐字段填写\n',
  ...overrides,
});

describe('estimateTokens', () => {
  it('CJK 字符按 1 token/字估算', () => {
    expect(estimateTokens('表单填写')).toBe(4);
  });

  it('ASCII 按 4 字符/token 估算（向上取整）', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('混合文本分段累计', () => {
    expect(estimateTokens('表单fill')).toBe(2 + Math.ceil(4 / 4));
  });

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('buildSkillL1Section', () => {
  it('空列表返回空串', () => {
    expect(buildSkillL1Section([])).toBe('');
  });

  it('正常清单：头部两行 + 逐条目格式', () => {
    const section = buildSkillL1Section([summary(), summary({ id: 'page-qa', name: '页面问答', description: '问答指南' })]);
    const lines = section.split('\n');
    expect(lines[0]).toBe('[skills]');
    expect(lines[1]).toContain(SKILL_TOOL_NAME);
    expect(lines[2]).toBe('- 表单填写助手（id: form-fill）：如何在页面中定位并填写表单字段的实践指南');
    expect(lines[3]).toBe('- 页面问答（id: page-qa）：问答指南');
  });

  it('默认预算 = 100,000（D3）', () => {
    expect(SKILL_L1_TOKEN_BUDGET).toBe(100_000);
  });

  it('超预算截断并追加截断说明行', () => {
    const summaries = [
      summary(),
      summary({ id: 'big', name: '大技能', description: '很'.repeat(200) }),
      summary({ id: 'c', name: '技能C', description: 'd' }),
    ];
    const section = buildSkillL1Section(summaries, 10);
    expect(section).toContain('- 表单填写助手');
    expect(section).toContain('剩余 2 个技能未收录');
    expect(section).not.toContain('技能C（');
  });

  it('首条无条件收录（即使单独超预算），保证清单非空', () => {
    const section = buildSkillL1Section([summary({ description: '很'.repeat(500) })], 5);
    expect(section).toContain('- 表单填写助手');
  });
});

describe('createSkillToolDefinition / parseSkillToolArgs / 结果包装', () => {
  it('工具定义：名称、schema 必填 id', () => {
    const def = createSkillToolDefinition();
    expect(def.name).toBe(SKILL_TOOL_NAME);
    const schema = def.inputSchema as { type: string; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['id']);
  });

  it('parseSkillToolArgs：合法 id 原样返回（trim）', () => {
    expect(parseSkillToolArgs({ id: ' form-fill ' })).toBe('form-fill');
  });

  it('parseSkillToolArgs：缺失 / 非字符串 / 空串 抛错', () => {
    expect(() => parseSkillToolArgs({})).toThrow('id');
    expect(() => parseSkillToolArgs({ id: 42 })).toThrow('id');
    expect(() => parseSkillToolArgs({ id: '  ' })).toThrow('id');
  });

  it('toSkillToolResult：MCP 形状，isError false，内容带头部', () => {
    const result = toSkillToolResult(definition());
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toContain('# 表单填写助手（id: form-fill）');
    expect(result.content[0]!.text).toContain('逐字段填写');
  });

  it('toSkillToolError：isError true，文本承载原因', () => {
    const result = toSkillToolError('技能不存在：x');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('技能加载失败');
    expect(result.content[0]!.text).toContain('技能不存在：x');
  });
});

describe('createSkillResolver（D2：覆写 → assets → 缺失报错）', () => {
  it('覆写优先于 assets', async () => {
    const resolver = createSkillResolver({
      loadOverride: async () => definition({ content: '覆写版内容' }),
      loadAsset: async () => definition({ content: '内置版内容' }),
    });
    const resolved = await resolver.resolve('form-fill');
    expect(resolved.content).toBe('覆写版内容');
  });

  it('无覆写时回落 assets', async () => {
    const resolver = createSkillResolver({
      loadOverride: async () => null,
      loadAsset: async () => definition({ content: '内置版内容' }),
    });
    expect((await resolver.resolve('form-fill')).content).toBe('内置版内容');
  });

  it('覆写读取异常视同无覆写，不阻断 assets 兜底', async () => {
    const resolver = createSkillResolver({
      loadOverride: async () => {
        throw new Error('storage boom');
      },
      loadAsset: async () => definition(),
    });
    expect((await resolver.resolve('form-fill')).content).toContain('步骤');
  });

  it('覆写 id 与请求不一致时忽略覆写（防串号）', async () => {
    const resolver = createSkillResolver({
      loadOverride: async () => definition({ id: 'other' }),
      loadAsset: async () => definition({ content: '内置版' }),
    });
    expect((await resolver.resolve('form-fill')).content).toBe('内置版');
  });

  it('两级源都未命中时抛错', async () => {
    const resolver = createSkillResolver({
      loadOverride: async () => null,
      loadAsset: async () => null,
    });
    await expect(resolver.resolve('nope')).rejects.toThrow('nope');
  });
});

describe('matchSkillTriggers（可选预触发）', () => {
  it('命中 keywords 返回技能 id 列表', () => {
    const summaries = [
      summary({ id: 'a', keywords: ['表单', '填写'] }),
      summary({ id: 'b', keywords: ['截图'] }),
      summary({ id: 'c' }),
    ];
    expect(matchSkillTriggers('帮我填写这个表单', summaries)).toEqual(['a']);
  });

  it('无命中 / 空 keywords 返回空数组', () => {
    expect(matchSkillTriggers('随便聊聊', [summary({ keywords: ['表单'] }), summary()])).toEqual([]);
  });
});

describe('composeSystemPrompt skills 段（P2 扩展）', () => {
  const agent: AgentProfile = {
    id: 'multi-turn-loop',
    name: '多轮循环智能体',
    description: 'd',
    rules: { inheritGlobal: true, items: [{ id: 'r1', text: '完整循环。' }] },
    skills: [],
    mcps: [],
  };

  it('skillSection 非空时追加 [skills] 段（位于 rules 段之后）', () => {
    const prompt = composeSystemPrompt(agent, '全局提示', { skillSection: buildSkillL1Section([summary()]) });
    expect(prompt).toBe(
      `[rules:global]\n全局提示\n\n[rules:agent:multi-turn-loop:r1]\n完整循环。\n\n[skills]\n以下为可用技能清单（需要全文时调用 ${SKILL_TOOL_NAME} 工具并传入技能 id）：\n- 表单填写助手（id: form-fill）：如何在页面中定位并填写表单字段的实践指南`
    );
  });

  it('skillSection 为空串/缺省时不追加', () => {
    expect(composeSystemPrompt(agent, '全局', { skillSection: '' })).not.toContain('[skills]');
    expect(composeSystemPrompt(agent, '全局')).not.toContain('[skills]');
  });

  it('activeAgent 为 null 时忽略 skillSection（无智能体即无技能绑定）', () => {
    expect(composeSystemPrompt(null, '全局', { skillSection: buildSkillL1Section([summary()]) })).toBe('全局');
  });
});
