// chat-controller 单测：依赖注入桩覆盖编排全链路（配置守卫 / busy / 事件转发 /
// 错误分型 / 历史维护 / 日志事件），不经真实 fetch。
import { describe, expect, it, vi } from 'vitest';
import { AgentAbortError, type AgentLoopEvent, type ChatMessage, type LlmChatClient } from './agent-loop';
import { ABORTED_TURN_TEXT, createChatController, type ChatControllerDeps, type ChatTurnView } from './chat-controller';

const tools = [{ name: 'get_status', description: 'Get status', inputSchema: { type: 'object' } }];

const validConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com',
  model: 'test-model',
};

/** 组装依赖桩：LLM 按脚本回放，工具与 UI 适配器可断言。 */
function makeDeps(overrides: Partial<ChatControllerDeps> = {}, llmScript: ChatMessage[] = [{ role: 'assistant', content: 'ok' }]) {
  const events: AgentLoopEvent[] = [];
  const texts: string[] = [];
  const logs: Array<{ level: string; event: string; payload?: unknown }> = [];
  const userMessages: string[] = [];
  const view: ChatTurnView & { events: AgentLoopEvent[]; texts: string[] } = {
    events,
    texts,
    onEvent(event) {
      events.push(event);
    },
    setText(text) {
      texts.push(text);
    },
  };
  let callIndex = 0;
  const llm: LlmChatClient = {
    async complete(messages) {
      void messages;
      const next = llmScript[callIndex];
      callIndex += 1;
      if (!next) throw new Error('脚本响应已耗尽');
      return next;
    },
  };
  const deps: ChatControllerDeps = {
    getTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => ({ ok: true })),
    getLlmConfig: vi.fn(() => ({ ...validConfig })),
    getSystemPrompt: vi.fn(() => ''),
    getMaxHistoryTurns: vi.fn(() => 0),
    onUserMessage: vi.fn((text: string) => userMessages.push(text)),
    createTurnView: vi.fn(() => view),
    onMissingApiKey: vi.fn(),
    onMissingApiPath: vi.fn(),
    onTurnStart: vi.fn(),
    onTurnSettled: vi.fn(),
    createLlm: vi.fn(() => llm),
    onLog: (level, event, payload) => logs.push({ level, event, payload }),
    ...overrides,
  };
  return { deps, view, events, texts, logs, userMessages };
}

describe('createChatController', () => {
  it('快乐路径：用户消息落 UI → 事件转发 → 最终文案 → 历史更新 → busy 复位', async () => {
    const { deps, view } = makeDeps({}, [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', function: { name: 'get_status', arguments: '{}' } }] },
      { role: 'assistant', content: '状态正常' },
    ]);
    const busyTrace: boolean[] = [];
    const controller = createChatController({ ...deps, onBusyChange: (busy) => busyTrace.push(busy) });

    await controller.runTurn('检查页面');

    expect(deps.onUserMessage).toHaveBeenCalledWith('检查页面');
    expect(deps.callTool).toHaveBeenCalledWith('get_status', {});
    expect(view.texts).toEqual(['状态正常']);
    expect(controller.getHistory()).toHaveLength(4); // user + assistant(toolCalls) + tool + assistant(final)
    expect(busyTrace).toEqual([true, false]);
    expect(controller.isBusy()).toBe(false);
    expect(deps.onTurnStart).toHaveBeenCalled();
    expect(deps.onTurnSettled).toHaveBeenCalled();
  });

  it('apiKey 缺失：触发 onMissingApiKey，不发起任何 LLM 调用，不置 busy', async () => {
    const { deps } = makeDeps();
    const controller = createChatController({
      ...deps,
      getLlmConfig: () => ({ ...validConfig, apiKey: '' }),
    });

    await controller.runTurn('hi');

    expect(deps.onMissingApiKey).toHaveBeenCalled();
    expect(deps.createLlm).not.toHaveBeenCalled();
    expect(deps.onUserMessage).not.toHaveBeenCalled();
    expect(controller.isBusy()).toBe(false);
  });

  it('apiPath 显式空串：触发 onMissingApiPath，不发起请求', async () => {
    const { deps } = makeDeps();
    const controller = createChatController({
      ...deps,
      getLlmConfig: () => ({ ...validConfig, apiPath: '' }),
    });

    await controller.runTurn('hi');

    expect(deps.onMissingApiPath).toHaveBeenCalled();
    expect(deps.createLlm).not.toHaveBeenCalled();
  });

  it('busy 守卫：进行中再调 runTurn 直接忽略', async () => {
    const { deps } = makeDeps({}, [{ role: 'assistant', content: 'ok' }]);
    const controller = createChatController(deps);

    const first = controller.runTurn('第一轮');
    const second = controller.runTurn('第二轮');
    await Promise.all([first, second]);

    // 第二轮被 busy 守卫吞掉：仅一轮 user 消息
    expect(deps.onUserMessage).toHaveBeenCalledTimes(1);
  });

  it('终止语义：LLM 抛 AgentAbortError 时 setText 终止文案并记录 turn_aborted', async () => {
    const { deps, view, logs } = makeDeps();
    const controller = createChatController({
      ...deps,
      createLlm: () => ({
        async complete() {
          throw new AgentAbortError();
        },
      }),
    });

    await controller.runTurn('被终止');

    expect(view.texts).toEqual([ABORTED_TURN_TEXT]);
    expect(logs.some((entry) => entry.event === 'turn_aborted')).toBe(true);
  });

  it('错误分型：普通异常 setText「出错了：…」并记录 turn_error', async () => {
    const { deps, view, logs } = makeDeps();
    const controller = createChatController({
      ...deps,
      createLlm: () => ({
        async complete() {
          throw new Error('网络炸了');
        },
      }),
    });

    await controller.runTurn('hi');

    expect(view.texts).toEqual(['出错了：网络炸了']);
    expect(logs.some((entry) => entry.event === 'turn_error')).toBe(true);
  });

  it('历史裁剪：maxHistoryTurns 生效且请求消息以本轮 user 收尾', async () => {
    const seenMessages: ChatMessage[][] = [];
    const { deps } = makeDeps();
    const controller = createChatController({
      ...deps,
      getMaxHistoryTurns: () => 1,
      createLlm: () => ({
        async complete(messages) {
          seenMessages.push([...messages]);
          return { role: 'assistant', content: `回复${String(seenMessages.length)}` };
        },
      }),
    });

    await controller.runTurn('第一轮');
    await controller.runTurn('第二轮');

    // 第二轮请求：system + 最近 1 轮（第一轮 user+assistant）+ 本轮 user
    const secondCall = seenMessages[1] ?? [];
    expect(secondCall.some((m) => m.role === 'system')).toBe(true);
    expect(secondCall[secondCall.length - 1]).toEqual({ role: 'user', content: '第二轮' });
    expect(secondCall.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('clearHistory 清空跨轮历史', async () => {
    const { deps } = makeDeps();
    const controller = createChatController(deps);

    await controller.runTurn('第一轮');
    expect(controller.getHistory().length).toBeGreaterThan(0);
    controller.clearHistory();
    expect(controller.getHistory()).toHaveLength(0);
  });

  it('日志事件：turn_start / turn_end 均经 onLog 注入', async () => {
    const { deps, logs } = makeDeps({}, [{ role: 'assistant', content: 'done' }]);
    const controller = createChatController(deps);

    await controller.runTurn('你好');

    const events = logs.map((entry) => entry.event);
    expect(events[0]).toBe('turn_start');
    expect(events).toContain('turn_end');
  });
});
