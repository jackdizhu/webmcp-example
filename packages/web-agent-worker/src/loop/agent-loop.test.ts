// agent-loop 单测：多轮 tool_calls 循环 / 迭代上限 / abort / 入参 JSON 非法自愈 /
// trimHistory 轮配对 / listTools 动态清单。
import { describe, expect, it, vi } from 'vitest';
import {
  AgentAbortError,
  DEFAULT_SYSTEM_PROMPT,
  runAgentLoop,
  trimHistory,
  type AgentTool,
  type ChatMessage,
  type LlmChatClient,
  type ToolCallRequest,
} from './agent-loop';

/** 桩工具。 */
const echoTool: AgentTool = { name: 'echo', description: '回声', inputSchema: { type: 'object' } };

/** 构造带 tool_calls 的 assistant 消息。 */
function assistantWithCalls(calls: ToolCallRequest[]): ChatMessage {
  return { role: 'assistant', content: '', toolCalls: calls };
}

function textCall(id: string, name: string, args: Record<string, unknown>): ToolCallRequest {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

/** 依序回放预设响应的 LLM 桩。 */
function scriptedLlm(responses: ChatMessage[]): { client: LlmChatClient; calls: Array<{ tools: readonly AgentTool[] }> } {
  const calls: Array<{ tools: readonly AgentTool[] }> = [];
  let index = 0;
  return {
    calls,
    client: {
      async complete(_messages, tools) {
        calls.push({ tools });
        const response = responses[Math.min(index, responses.length - 1)]!;
        index += 1;
        return response;
      },
    },
  };
}

describe('runAgentLoop', () => {
  it('无工具调用 → 首轮文本即最终回复', async () => {
    const { client } = scriptedLlm([{ role: 'assistant', content: '完成' }]);
    const result = await runAgentLoop({
      history: [{ role: 'user', content: 'hi' }],
      tools: [],
      deps: { llm: client, executeTool: vi.fn() },
    });
    expect(result.text).toBe('完成');
    expect(result.transcript.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('工具调用循环：执行结果回填，最终文本返回', async () => {
    const { client } = scriptedLlm([
      assistantWithCalls([textCall('c1', 'echo', { v: 1 })]),
      { role: 'assistant', content: '结果：{"v":1}' },
    ]);
    const executeTool = vi.fn(async () => ({ v: 1 }));
    const result = await runAgentLoop({
      history: [{ role: 'user', content: '调用 echo' }],
      tools: [echoTool],
      deps: { llm: client, executeTool },
    });
    expect(executeTool).toHaveBeenCalledWith('echo', { v: 1 });
    expect(result.text).toBe('结果：{"v":1}');
    expect(result.transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('达到迭代上限 → 返回上限提示文本', async () => {
    const { client } = scriptedLlm([assistantWithCalls([textCall('c1', 'echo', {})])]);
    const result = await runAgentLoop({
      history: [{ role: 'user', content: 'loop' }],
      tools: [echoTool],
      deps: { llm: client, executeTool: async () => 'x' },
      options: { maxIterations: 2 },
    });
    expect(result.text).toContain('迭代上限（2 次）');
  });

  it('入参 JSON 非法 → 错误文本回填（模型自我纠正），不抛异常', async () => {
    const { client } = scriptedLlm([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 'echo', arguments: '{bad json' } }] },
      { role: 'assistant', content: '已纠正' },
    ]);
    const executeTool = vi.fn();
    const result = await runAgentLoop({
      history: [{ role: 'user', content: 'x' }],
      tools: [echoTool],
      deps: { llm: client, executeTool },
    });
    expect(executeTool).not.toHaveBeenCalled();
    const toolMessage = result.transcript.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('不是合法的 JSON 对象');
  });

  it('工具执行抛错 → 错误文本化回填并触发 tool_error 事件', async () => {
    const { client } = scriptedLlm([
      assistantWithCalls([textCall('c1', 'echo', {})]),
      { role: 'assistant', content: 'ok' },
    ]);
    const events: string[] = [];
    const result = await runAgentLoop({
      history: [{ role: 'user', content: 'x' }],
      tools: [echoTool],
      deps: { llm: client, executeTool: async () => { throw new Error('boom'); } },
      options: { onEvent: (e) => events.push(e.type) },
    });
    const toolMessage = result.transcript.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('boom');
    expect(events).toContain('tool_error');
  });

  it('abort 后下轮边界抛 AgentAbortError', async () => {
    const controller = new AbortController();
    const { client } = scriptedLlm([assistantWithCalls([textCall('c1', 'echo', {})])]);
    const promise = runAgentLoop({
      history: [{ role: 'user', content: 'x' }],
      tools: [echoTool],
      deps: { llm: client, executeTool: async () => { controller.abort(); return 'x'; } },
      options: { signal: controller.signal },
    });
    await expect(promise).rejects.toBeInstanceOf(AgentAbortError);
  });

  it('listTools：每轮取最新清单；缺省回退静态清单', async () => {
    const dynamic: AgentTool[] = [echoTool];
    const { client, calls } = scriptedLlm([
      assistantWithCalls([textCall('c1', 'echo', {})]),
      { role: 'assistant', content: 'done' },
    ]);
    await runAgentLoop({
      history: [{ role: 'user', content: 'x' }],
      tools: [echoTool],
      deps: {
        llm: client,
        listTools: () => [...dynamic],
        executeTool: async () => {
          dynamic.length = 0; // 模拟超时移除：下一轮 LLM 视野内无工具
          return 'x';
        },
      },
    });
    expect(calls[0]!.tools).toHaveLength(1);
    expect(calls[1]!.tools).toHaveLength(0);
  });

  it('缺省 systemPrompt 为内置提示', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('工具');
  });
});

describe('trimHistory', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: '', toolCalls: [textCall('c1', 'echo', {})] },
    { role: 'tool', content: 'r1', toolCallId: 'c1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ];

  it('按轮裁剪且切点落在 user 消息（tool 消息配对完整）', () => {
    const trimmed = trimHistory(history, 1);
    expect(trimmed.map((m) => m.content)).toEqual(['q2', 'a2']);
  });

  it('轮数不足 / 非法 maxTurns 原样浅拷贝返回', () => {
    expect(trimHistory(history, 5)).toHaveLength(6);
    expect(trimHistory(history, 0)).toHaveLength(6);
    expect(trimHistory(history, -1)).toHaveLength(6);
  });
});
