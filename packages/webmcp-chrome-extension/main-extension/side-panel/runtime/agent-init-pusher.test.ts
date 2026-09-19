// agent-init-pusher 单测：500ms 去抖合并、Q6 双条件过滤（已连接 + 清单含通道工具）、
// 单页签失败不影响其他页签（失败仅日志）、dispose 取消挂起推送。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInitSnapshot } from 'webmcp-agent-chat-core';
import { createAgentInitPusher, type AgentInitPusherDeps } from './agent-init-pusher';

const snapshot = (): AgentInitSnapshot => ({
  agents: [],
  activeAgentId: null,
  a2aRefs: [],
  skills: [],
  tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }],
});

const INIT_TOOL = 'web_mcp_agent_initialization';

interface Harness {
  pusher: ReturnType<typeof createAgentInitPusher>;
  deps: AgentInitPusherDeps;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  logs: Array<{ level: string; event: string }>;
}

function createHarness(options: { tabs?: number[]; toolNames?: (tabId: number) => string[]; callError?: (tabId: number) => Error | null } = {}): Harness {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const logs: Array<{ level: string; event: string }> = [];
  const deps: AgentInitPusherDeps = {
    listConnectedTabs: () => options.tabs ?? [],
    getTabToolNames: async (tabId) => options.toolNames?.(tabId) ?? [INIT_TOOL],
    callTool: async (name, args) => {
      const tabId = Number(name.match(/^tab(\d+)__/)?.[1] ?? -1);
      const error = options.callError?.(tabId) ?? null;
      if (error) throw error;
      calls.push({ name, args });
      return {};
    },
    getInitSnapshot: async () => snapshot(),
    onLog: (level, event) => {
      logs.push({ level, event });
    },
  };
  const pusher = createAgentInitPusher(deps);
  return { pusher, deps, calls, logs };
}

describe('createAgentInitPusher（C6 推送路径）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedule 后去抖 500ms 推送一次：逐页签 callTool(tab<id>__init 工具, payload)，快照按页签组装', async () => {
    const h = createHarness({ tabs: [1, 2] });
    const seenTabIds: number[] = [];
    h.deps.getInitSnapshot = async (tabId) => {
      seenTabIds.push(tabId);
      return snapshot();
    };
    h.pusher.schedule();
    await vi.advanceTimersByTimeAsync(499);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((call) => call.name)).toEqual([
      `tab1__${INIT_TOOL}`,
      `tab2__${INIT_TOOL}`,
    ]);
    expect(seenTabIds).toEqual([1, 2]);
    const payload = h.calls[0]?.args as { version: number; tools: unknown[] };
    expect(payload.version).toBe(1);
    expect(payload.tools).toEqual([{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }]);
    expect(h.logs.some((log) => log.event === 'agent_init_pushed')).toBe(true);
  });

  it('去抖合并：窗口内多次 schedule 只触发一轮推送', async () => {
    const h = createHarness({ tabs: [7] });
    h.pusher.schedule();
    h.pusher.schedule();
    h.pusher.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls).toHaveLength(1);
  });

  it('Q6 过滤：页签未注册初始化工具 → 跳过（不组快照、不调用）', async () => {
    const h = createHarness({
      tabs: [1, 2],
      toolNames: (tabId) => (tabId === 1 ? ['echo'] : [INIT_TOOL]),
    });
    h.pusher.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls.map((call) => call.name)).toEqual([`tab2__${INIT_TOOL}`]);
  });

  it('失败隔离：页签 1 callTool 抛错仅记日志，页签 2 照常推送', async () => {
    const h = createHarness({
      tabs: [1, 2],
      callError: (tabId) => (tabId === 1 ? new Error('页签已刷新') : null),
    });
    h.pusher.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls.map((call) => call.name)).toEqual([`tab2__${INIT_TOOL}`]);
    const failed = h.logs.find((log) => log.event === 'agent_init_push_failed');
    expect(failed?.level).toBe('error');
  });

  it('dispose 后 schedule 不再触发推送', async () => {
    const h = createHarness({ tabs: [1] });
    h.pusher.dispose();
    h.pusher.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(0);
  });

  it('dispose 取消已挂起的去抖定时器', async () => {
    const h = createHarness({ tabs: [1] });
    h.pusher.schedule();
    h.pusher.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(0);
  });
});
