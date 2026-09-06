import { describe, expect, it, vi } from 'vitest';
import {
  AgentAbortError,
  runAgentLoop,
  type AgentLoopEvent,
  type AgentTool,
  type ChatMessage,
  type LlmChatClient,
} from './agent-loop';

const tools: AgentTool[] = [
  { name: 'get_status', description: 'Get page status', inputSchema: { type: 'object' } },
];

/** 按脚本顺序回放 LLM 响应的桩客户端，并记录每次请求的完整消息。 */
function scriptedLlm(responses: ChatMessage[]): LlmChatClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let index = 0;
  return {
    calls,
    async complete(messages) {
      calls.push([...messages]);
      const next = responses[index];
      index += 1;
      if (!next) throw new Error('脚本响应已耗尽');
      return next;
    },
  };
}

/** 构造一条以用户消息结尾的历史。 */
function historyOf(...items: ChatMessage[]): ChatMessage[] {
  return items;
}

describe('runAgentLoop', () => {
  it('LLM 直接回复文本时不调用工具并返回最终文本', async () => {
    const llm = scriptedLlm([{ role: 'assistant', content: '页面一切正常' }]);
    const executeTool = vi.fn();
    const history = historyOf(
      { role: 'user', content: '上一轮问题' },
      { role: 'assistant', content: '上一轮回答' },
      { role: 'user', content: '检查一下页面' }
    );

    const result = await runAgentLoop(history, tools, { llm, executeTool });

    expect(result.text).toBe('页面一切正常');
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.transcript).toHaveLength(4);
    expect(result.transcript[2]?.content).toBe('检查一下页面');
    // system 提示词只在请求时拼接，不进入 transcript
    expect(result.transcript.some((m) => m.role === 'system')).toBe(false);
    // 请求消息以 system 开头且包含完整历史
    expect(llm.calls[0]?.[0]?.role).toBe('system');
    expect(llm.calls[0]).toHaveLength(4);
  });

  it('工具调用后把结果回填并继续对话直到最终文本', async () => {
    const llm = scriptedLlm([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 'get_status', arguments: '{"verbose":true}' } }] },
      { role: 'assistant', content: '状态正常' },
    ]);
    const executeTool = vi.fn(async () => ({ ok: true }));
    const events: AgentLoopEvent[] = [];

    const result = await runAgentLoop(historyOf({ role: 'user', content: '调用 get_status' }), tools, {
      llm,
      executeTool,
    }, {
      onEvent: (event) => events.push(event),
    });

    expect(executeTool).toHaveBeenCalledWith('get_status', { verbose: true });
    expect(result.text).toBe('状态正常');
    const toolMessage = result.transcript.find((m) => m.role === 'tool');
    expect(toolMessage?.toolCallId).toBe('c1');
    expect(toolMessage?.content).toBe('{"ok":true}');
    expect(events.some((e) => e.type === 'tool_start' && e.name === 'get_status')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.result === '{"ok":true}')).toBe(true);
  });

  it('工具入参非 JSON 对象时不执行工具并把错误回填给模型', async () => {
    const llm = scriptedLlm([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', function: { name: 'get_status', arguments: 'oops' } }] },
      { role: 'assistant', content: '已了解参数错误' },
    ]);
    const executeTool = vi.fn();

    const result = await runAgentLoop(historyOf({ role: 'user', content: '调用工具' }), tools, {
      llm,
      executeTool,
    });

    expect(executeTool).not.toHaveBeenCalled();
    const toolMessage = result.transcript.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('错误');
  });

  it('工具执行抛错时把错误信息回填给模型', async () => {
    const llm = scriptedLlm([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c3', function: { name: 'get_status', arguments: '{}' } }] },
      { role: 'assistant', content: '已了解执行失败' },
    ]);
    const executeTool = vi.fn(async () => {
      throw new Error('工具不存在');
    });

    const result = await runAgentLoop(historyOf({ role: 'user', content: '调用工具' }), tools, {
      llm,
      executeTool,
    });

    const toolMessage = result.transcript.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('错误：工具不存在');
  });

  it('达到迭代上限时返回提示文本而非静默结束', async () => {
    const llm = scriptedLlm([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c4', function: { name: 'get_status', arguments: '{}' } }] },
    ]);
    const executeTool = vi.fn(async () => ({ ok: true }));

    const result = await runAgentLoop(historyOf({ role: 'user', content: '循环调用' }), tools, {
      llm,
      executeTool,
    }, { maxIterations: 1 });

    expect(result.text).toContain('迭代上限');
  });

  it('signal 已中止时抛 AgentAbortError 且不发起 LLM 请求', async () => {
    const llm = scriptedLlm([{ role: 'assistant', content: '不应到达' }]);
    const executeTool = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAgentLoop(historyOf({ role: 'user', content: '被终止' }), tools, { llm, executeTool }, {
        signal: controller.signal,
      })
    ).rejects.toThrow(AgentAbortError);
    expect(llm.calls).toHaveLength(0);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('工具执行中终止：当前调用完成后停止，不再继续下一轮', async () => {
    const llm = scriptedLlm([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c5', function: { name: 'get_status', arguments: '{}' } }] },
      { role: 'assistant', content: '不应到达' },
    ]);
    const executeTool = vi.fn(async () => {
      // 工具执行期间用户点「终止」
      controller.abort();
      return { ok: true };
    });
    const controller = new AbortController();

    await expect(
      runAgentLoop(historyOf({ role: 'user', content: '执行一半被终止' }), tools, { llm, executeTool }, {
        signal: controller.signal,
      })
    ).rejects.toThrow(AgentAbortError);
    // 工具调用完成了，但不再发起第二次 LLM 请求
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('signal 透传给 LLM 客户端（fetch 中断用）', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const llm: LlmChatClient = {
      async complete(_messages, _tools, signal) {
        seenSignals.push(signal);
        return { role: 'assistant', content: 'done' };
      },
    };
    const controller = new AbortController();

    const result = await runAgentLoop(historyOf({ role: 'user', content: 'hi' }), tools, { llm, executeTool: vi.fn() }, {
      signal: controller.signal,
    });

    expect(result.text).toBe('done');
    expect(seenSignals[0]).toBe(controller.signal);
  });
});
