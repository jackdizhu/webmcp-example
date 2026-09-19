// agent-task-host 单测：受理校验与错误回发、任务队列容量（Q9）、agent 任务终态
// （completed / 超时 TASK_TIMED_OUT / 终止 cancelled）、tool 任务 4 步解析（Q6）、
// 会话归档时序（running 归档 + 终态覆写）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmChatClient } from 'webmcp-agent-chat-core';
import { AgentAbortError } from 'webmcp-agent-chat-core';
import type { StoredChatSession } from '../sessions/session-core';
import {
  AGENT_TASK_HOST_PORT_NAME,
  type AgentTaskRoutedCreateMessage,
  type AgentTaskRoutedInitRequestMessage,
} from '../../../core/agent-task-protocol';
import { createAgentTaskHost, resolveToolName, type AgentTaskHostDeps } from './agent-task-host';

type MessageListener = (message: unknown) => void;

/** chrome.runtime.Port 桩：emit 模拟 SW 下发，posted 收集宿主应答。 */
class StubHostPort {
  private readonly messageListeners: MessageListener[] = [];
  readonly posted: unknown[] = [];

  get onMessage() {
    return {
      addListener: (fn: MessageListener) => this.messageListeners.push(fn),
      removeListener: () => {},
    };
  }

  get onDisconnect() {
    return { addListener: () => {}, removeListener: () => {} };
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {}

  /** 模拟 SW 路由下发行消息（create-task / init-request）。 */
  emit(message: AgentTaskRoutedCreateMessage | AgentTaskRoutedInitRequestMessage): void {
    for (const fn of this.messageListeners) fn(message);
  }
}

const asPort = (stub: StubHostPort): chrome.runtime.Port => stub as unknown as chrome.runtime.Port;

const profile = {
  id: 'a2a-analyst',
  name: '通用智能体',
  description: 'd',
  rules: { inheritGlobal: false, items: [] },
  skills: [],
  mcps: [],
};

const skillSummary = { id: 'page-tools-guide', name: '页面工具使用指南', description: 'g' };

interface Harness {
  host: ReturnType<typeof createAgentTaskHost>;
  port: StubHostPort;
  archives: StoredChatSession[];
  deps: AgentTaskHostDeps;
  setLlm: (llm: LlmChatClient) => void;
  activity: () => number;
}

/** 已 start 的宿主实例（afterEach 统一 dispose，避免悬空定时器/监听器）。 */
const activeHosts: Array<ReturnType<typeof createAgentTaskHost>> = [];

function createHarness(): Harness {
  const port = new StubHostPort();
  const archives: StoredChatSession[] = [];
  let llm: LlmChatClient = {
    async complete() {
      return { role: 'assistant', content: 'ok' };
    },
  };
  let activityCount = 0;
  const deps: AgentTaskHostDeps = {
    listTools: async () => [
      { name: 'tab1__echo', description: 'e', inputSchema: { type: 'object' } },
      { name: 'chrome_extension_get_document_info', description: 'd', inputSchema: { type: 'object' } },
      { name: 'tab2__get_document_info', description: 'd2', inputSchema: { type: 'object' } },
    ],
    callTool: async () => ({ content: [{ type: 'text', text: 'page' }] }),
    listAgentProfiles: () => [profile],
    listSkillSummaries: () => [skillSummary],
    getGlobalSystemPrompt: () => '全局规则',
    getInitSnapshot: async (tabId) => ({
      agents: [profile],
      activeAgentId: 'a2a-analyst',
      a2aRefs: [],
      skills: [skillSummary],
      tools: tabId === 2
        ? [{ name: 'tab2__get_document_info', description: 'd2', inputSchema: { type: 'object' } }]
        : [{ name: 'tab1__echo', description: 'e', inputSchema: { type: 'object' } }],
    }),
    getLlmBaseConfig: () => ({ apiKey: 'k', baseUrl: 'https://x', model: 'm' }),
    createLlm: () => llm,
    archiveSession: async (session) => {
      archives.push(session);
    },
    onLog: () => {},
    onTaskActivity: () => {
      activityCount += 1;
    },
  };
  const host = createAgentTaskHost(deps, () => asPort(port));
  host.start();
  activeHosts.push(host);
  return {
    host,
    port,
    archives,
    deps,
    setLlm: (next) => {
      llm = next;
    },
    activity: () => activityCount,
  };
}

const routedCreate = (overrides: Partial<AgentTaskRoutedCreateMessage> = {}): AgentTaskRoutedCreateMessage => ({
  type: 'create-task',
  requestId: 'req-1',
  payload: { taskType: 'agent', agentName: '通用智能体', agentPrompt: '读取大纲' },
  sender: { tabId: 11, origin: 'https://example.com' },
  ...overrides,
});

const routedInit = (overrides: Partial<AgentTaskRoutedInitRequestMessage> = {}): AgentTaskRoutedInitRequestMessage => ({
  type: 'init-request',
  requestId: 'init-1',
  sender: { tabId: 11, origin: 'https://example.com' },
  ...overrides,
});

describe('createAgentTaskHost 受理与终态', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const host of activeHosts) host.dispose();
    activeHosts.length = 0;
    vi.useRealTimers();
  });

  it('非法入参直接 task-error（INVALID_PARAMS），不产生归档', () => {
    const h = createHarness();
    h.port.emit(routedCreate({ payload: { taskType: 'nope' } }));
    const error = h.port.posted[0] as { type: string; code: string };
    expect(error.type).toBe('task-error');
    expect(error.code).toBe('INVALID_PARAMS');
    expect(h.archives).toHaveLength(0);
  });

  it('未知名智能体 → task-error AGENT_NOT_FOUND（经 runner 解析映射）', () => {
    const h = createHarness();
    h.port.emit(routedCreate({ payload: { taskType: 'agent', agentName: '不存在', agentPrompt: 'p' } }));
    const error = h.port.posted[0] as { type: string; code: string };
    expect(error.code).toBe('AGENT_NOT_FOUND');
  });

  it('agent 任务全链路：ack → running 归档 → completed 终态归档 + task-done', async () => {
    const h = createHarness();
    h.port.emit(routedCreate());
    // ack 同步回发
    const ack = h.port.posted[0] as { type: string; requestId: string; sessionId: string };
    expect(ack.type).toBe('task-ack');
    expect(ack.requestId).toBe('req-1');
    // 开始即归档 running（Q12）
    await Promise.resolve();
    expect(h.archives[0]?.taskStatus).toBe('running');
    expect(h.archives[0]?.origin).toBe('https://example.com');
    // 轮次微任务推进至终态
    await vi.runAllTimersAsync();
    const done = h.port.posted.find((m) => (m as { type: string }).type === 'task-done') as {
      type: string;
      status: string;
      result: string;
      sessionId: string;
    };
    expect(done.status).toBe('completed');
    expect(done.result).toBe('ok');
    expect(done.sessionId).toBe(ack.sessionId);
    const terminal = h.archives[h.archives.length - 1];
    expect(terminal?.taskStatus).toBe('completed');
    expect(terminal?.id).toBe(ack.sessionId);
    expect(terminal?.messages.some((m) => m.role === 'assistant' && m.content === 'ok')).toBe(true);
    expect(terminal?.llmHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('LLM 抛 AgentAbortError → cancelled 终态（Q13 终止语义）', async () => {
    const h = createHarness();
    h.setLlm({
      async complete() {
        throw new AgentAbortError();
      },
    });
    h.port.emit(routedCreate());
    await vi.runAllTimersAsync();
    const done = h.port.posted.find((m) => (m as { type: string }).type === 'task-done') as { status: string };
    expect(done.status).toBe('cancelled');
  });

  it('agent 任务超时（10min）→ failed + TASK_TIMED_OUT（Q9）', async () => {
    const h = createHarness();
    h.setLlm({
      complete: (_messages, _tools, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new AgentAbortError()));
        }),
    });
    h.port.emit(routedCreate());
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    const done = h.port.posted.find((m) => (m as { type: string }).type === 'task-done') as {
      status: string;
      result: { code: string };
    };
    expect(done.status).toBe('failed');
    expect(done.result.code).toBe('TASK_TIMED_OUT');
  });

  it('队列容量 5（Q9）：执行 1 + 排队 4 后第 6 个 → QUEUE_FULL；终止执行中任务 → cancelled', async () => {
    const h = createHarness();
    h.setLlm({
      // 挂起但响应 abort：占住执行位，terminateTask 触发 AgentAbortError → cancelled
      complete: (_messages, _tools, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new AgentAbortError()));
        }),
    });
    for (let index = 1; index <= 6; index += 1) {
      h.port.emit(routedCreate({ requestId: `req-${index}` }));
    }
    const full = h.port.posted.find(
      (m) => (m as { type: string }).type === 'task-error' && (m as { requestId?: string }).requestId === 'req-6'
    ) as { code: string };
    expect(full.code).toBe('QUEUE_FULL');
    // 终止正在执行的任务（Q13：按当前展示会话的 sessionId 分派）
    const firstAck = h.port.posted[0] as { sessionId: string };
    expect(h.host.isTaskSession(firstAck.sessionId)).toBe(true);
    expect(h.host.terminateTask(firstAck.sessionId)).toBe(true);
    await vi.runAllTimersAsync();
    const done = h.port.posted.find((m) => (m as { type: string }).type === 'task-done') as { status: string };
    expect(done.status).toBe('cancelled');
  });

  it('tool 任务：调用方页签前缀解析（Q6 第 2 步）→ callTool 透传结果 → completed', async () => {
    const h = createHarness();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    h.deps.callTool = async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    };
    h.port.emit(
      routedCreate({
        sender: { tabId: 2, origin: 'https://example.com' },
        payload: { taskType: 'tool', toolName: 'get_document_info', toolProps: { includeOutline: true } },
      })
    );
    await vi.runAllTimersAsync();
    expect(calls[0]?.name).toBe('tab2__get_document_info');
    expect(calls[0]?.args).toEqual({ includeOutline: true });
    const done = h.port.posted.find((m) => (m as { type: string }).type === 'task-done') as {
      status: string;
      result: unknown;
    };
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({ ok: true });
  });
});

describe('createAgentTaskHost init 拉取（C6）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const host of activeHosts) host.dispose();
    activeHosts.length = 0;
    vi.useRealTimers();
  });

  it('init-request → getInitSnapshot(调用方 tabId) → init-data 应答；无任务语义（不归档/无 activity）', async () => {
    const h = createHarness();
    const seenTabIds: number[] = [];
    h.deps.getInitSnapshot = async (tabId) => {
      seenTabIds.push(tabId);
      return { agents: [profile], activeAgentId: 'a2a-analyst', a2aRefs: [], skills: [skillSummary], tools: [] };
    };
    h.port.emit(routedInit());
    await vi.runAllTimersAsync();
    expect(seenTabIds).toEqual([11]);
    expect(h.port.posted).toHaveLength(1);
    const data = h.port.posted[0] as {
      type: string;
      requestId: string;
      payload: { version: number; currentAgent: unknown; agents: unknown[]; a2aAgents: unknown[]; skills: unknown[] };
    };
    expect(data.type).toBe('init-data');
    expect(data.requestId).toBe('init-1');
    expect(data.payload.version).toBe(1);
    expect(data.payload.currentAgent).toEqual({ id: 'a2a-analyst', name: '通用智能体' });
    expect(data.payload.agents).toEqual([{ id: 'a2a-analyst', name: '通用智能体', description: 'd' }]);
    expect(data.payload.a2aAgents).toEqual([]);
    expect(data.payload.skills).toEqual([{ id: 'page-tools-guide', name: '页面工具使用指南', description: 'g' }]);
    // 无任务语义：不建会话、不触发 activity
    expect(h.archives).toHaveLength(0);
    expect(h.activity()).toBe(0);
  });

  it('getInitSnapshot 异常 → task-error EXECUTION_FAILED（不抛出、不悬挂）', async () => {
    const h = createHarness();
    h.deps.getInitSnapshot = async () => {
      throw new Error('快照组装失败');
    };
    h.port.emit(routedInit());
    await vi.runAllTimersAsync();
    expect(h.port.posted).toHaveLength(1);
    const error = h.port.posted[0] as { type: string; code: string };
    expect(error.type).toBe('task-error');
    expect(error.code).toBe('EXECUTION_FAILED');
  });
});

describe('resolveToolName（Q6 四步解析）', () => {
  const names = ['tab1__echo', 'chrome_extension_get_document_info', 'tab2__get_document_info'];

  it('第 1 步：精确命中', () => {
    expect(resolveToolName('tab1__echo', 11, names)).toEqual({ ok: true, name: 'tab1__echo' });
  });

  it('第 2 步：调用方页签前缀命中', () => {
    expect(resolveToolName('get_document_info', 2, names)).toEqual({
      ok: true,
      name: 'tab2__get_document_info',
    });
  });

  it('第 3 步：唯一后缀命中', () => {
    expect(resolveToolName('echo', 11, names)).toEqual({ ok: true, name: 'tab1__echo' });
  });

  it('第 4 步：多后缀候选 → AMBIGUOUS；零候选 → TOOL_NOT_FOUND', () => {
    const ambiguous = resolveToolName('get_document_info', 11, names);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.code).toBe('AMBIGUOUS_TOOL_NAME');
    const missing = resolveToolName('nope', 11, names);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('TOOL_NOT_FOUND');
  });
});

describe('宿主 Port 连接约定', () => {
  it('portFactory 收到宿主端口名（SW 侧按名分流）', () => {
    let observedName: string | null = null;
    const recordingFactory = (): chrome.runtime.Port => {
      const stub = new StubHostPort();
      observedName = AGENT_TASK_HOST_PORT_NAME;
      return asPort(stub);
    };
    const host = createAgentTaskHost(
      {
        listTools: async () => [],
        callTool: async () => ({}),
        listAgentProfiles: () => [],
        listSkillSummaries: () => [],
        getGlobalSystemPrompt: () => '',
        getInitSnapshot: async () => ({ agents: [], activeAgentId: null, a2aRefs: [], skills: [], tools: [] }),
        getLlmBaseConfig: () => ({ apiKey: 'k', baseUrl: 'https://x', model: 'm' }),
        archiveSession: async () => {},
        onLog: () => {},
        onTaskActivity: () => {},
      },
      recordingFactory
    );
    host.start();
    expect(observedName).toBe(AGENT_TASK_HOST_PORT_NAME);
    host.dispose();
  });
});
