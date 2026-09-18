// agent-task-runner 单测：智能体/技能解析（NOT_FOUND / AMBIGUOUS）、任务执行编排
// （系统提示词分层组装、技能 L1 注入 + 工具补位、transcript 形态）。
import { describe, expect, it } from 'vitest';
import type { AgentTool, ChatMessage, LlmChatClient } from './agent-loop';
import type { AgentProfile } from './agent-profile';
import type { SkillSummary } from './skill-loader';
import {
  resolveAgentProfile,
  resolveSkillSummary,
  runAgentTask,
  AgentTaskRunnerError,
} from './agent-task-runner';

const profileA: AgentProfile = {
  id: 'a2a-analyst',
  name: '通用智能体',
  description: 'd',
  rules: { inheritGlobal: true, items: [{ id: 'r1', text: 'A 规则' }] },
  skills: [],
  mcps: [],
};
const profileB: AgentProfile = {
  id: 'tool-debug',
  name: '单个tools调试',
  description: 'd',
  rules: { inheritGlobal: false, items: [] },
  skills: [],
  mcps: [],
};
const skill: SkillSummary = { id: 'page-tools-guide', name: '页面工具使用指南', description: 'g' };
const tool: AgentTool = { name: 'tab1__echo', description: 'e', inputSchema: { type: 'object' } };

/** LLM 桩：记录每次请求的完整消息与工具清单，可配置最终回复。 */
function stubLlm(reply: string): LlmChatClient & { calls: ChatMessage[][]; toolLists: AgentTool[][] } {
  const calls: ChatMessage[][] = [];
  const toolLists: AgentTool[][] = [];
  return {
    calls,
    toolLists,
    async complete(messages, tools) {
      calls.push([...messages]);
      toolLists.push([...tools]);
      return { role: 'assistant', content: reply };
    },
  };
}

describe('resolveAgentProfile', () => {
  const agents = [profileA, profileB];

  it('agentId 精确命中；未命中 → AGENT_NOT_FOUND', () => {
    expect(resolveAgentProfile(agents, { agentId: 'tool-debug' })).toBe(profileB);
    expect(() => resolveAgentProfile(agents, { agentId: 'nope' })).toThrowError(
      expect.objectContaining({ code: 'AGENT_NOT_FOUND' }) as AgentTaskRunnerError
    );
  });

  it('agentName 唯一命中；重名 → AMBIGUOUS_AGENT_NAME；无名 → AGENT_NOT_FOUND', () => {
    expect(resolveAgentProfile(agents, { agentName: '通用智能体' })).toBe(profileA);
    const duplicated = [...agents, { ...profileB, id: 'another' }];
    expect(() => resolveAgentProfile(duplicated, { agentName: '单个tools调试' })).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_AGENT_NAME' }) as AgentTaskRunnerError
    );
    expect(() => resolveAgentProfile(agents, { agentName: '不存在' })).toThrowError(
      expect.objectContaining({ code: 'AGENT_NOT_FOUND' }) as AgentTaskRunnerError
    );
  });

  it('agentId 优先于 agentName（Q8）', () => {
    expect(resolveAgentProfile(agents, { agentId: 'tool-debug', agentName: '通用智能体' })).toBe(profileB);
  });
});

describe('resolveSkillSummary', () => {
  it('按 name 精确命中；未命中 → SKILL_NOT_FOUND', () => {
    expect(resolveSkillSummary([skill], '页面工具使用指南')).toBe(skill);
    expect(() => resolveSkillSummary([skill], 'nope')).toThrowError(
      expect.objectContaining({ code: 'SKILL_NOT_FOUND' }) as AgentTaskRunnerError
    );
  });
});

describe('runAgentTask', () => {
  const baseDeps = {
    tools: [tool] as AgentTool[],
    executeTool: async () => ({}),
    globalSystemPrompt: '全局规则',
  };

  it('history 仅含任务 prompt；system 提示词 = 全局 + agent 规则分层', async () => {
    const llm = stubLlm('结论');
    const result = await runAgentTask({
      profile: profileA,
      prompt: '读取大纲',
      deps: { ...baseDeps, llm },
    });
    expect(result.text).toBe('结论');
    expect(result.transcript.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.transcript[0]).toEqual({ role: 'user', content: '读取大纲' });
    expect(llm.calls[0]?.[0]?.role).toBe('system');
    expect(llm.calls[0]?.[0]?.content).toContain('[rules:global]');
    expect(llm.calls[0]?.[0]?.content).toContain('全局规则');
    expect(llm.calls[0]?.[0]?.content).toContain('A 规则');
    // 无技能任务不追加技能加载工具
    expect(llm.calls[0]?.some((m) => m.role === 'assistant' && m.toolCalls)).toBeFalsy();
  });

  it('技能任务：L1 清单注入 system + __agent_load_skill 工具补位', async () => {
    const llm = stubLlm('done');
    await runAgentTask({
      profile: profileA,
      prompt: 'p',
      deps: { ...baseDeps, llm },
      skillSummary: skill,
    });
    expect(llm.calls[0]?.[0]?.content).toContain('[skills]');
    expect(llm.calls[0]?.[0]?.content).toContain('页面工具使用指南');
    const systemCalls = llm.calls[0] ?? [];
    expect(systemCalls.length).toBeGreaterThan(0);
  });

  it('技能任务在工具清单缺失加载器时自动补 __agent_load_skill（经 executeTool 可执行）', async () => {
    const llm = stubLlm('ok');
    await runAgentTask({
      profile: profileA,
      prompt: 'p',
      deps: { ...baseDeps, llm },
      skillSummary: skill,
    });
    expect(llm.toolLists[0]?.some((t) => t.name === '__agent_load_skill')).toBe(true);
  });

  it('无技能任务不注入 [skills] 段也不补加载工具', async () => {
    const llm = stubLlm('ok');
    await runAgentTask({ profile: profileA, prompt: 'p', deps: { ...baseDeps, llm } });
    expect(llm.calls[0]?.[0]?.content).not.toContain('[skills]');
    expect(llm.toolLists[0]?.some((t) => t.name === '__agent_load_skill')).toBe(false);
  });
});
