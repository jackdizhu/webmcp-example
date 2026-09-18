// agent-profile-store 单测：存储适配 + 幂等迁移 + 响应式切换（storage 桩注入，无 chrome 全局）。
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACTIVE_AGENT_ID, type AgentProfilesState } from 'webmcp-agent-chat-core';
import { AGENT_PROFILES_CORRUPT_KEY, AGENT_PROFILES_STORAGE_KEY, createAgentProfileStore, type ProfileStorageLike } from './agent-profile-store';

/** 可编程 storage 桩：追加式写入记录，get 返回当前数据快照。 */
function createStorageStub(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const writes: Array<Record<string, unknown>> = [];
  const stub: ProfileStorageLike = {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items) {
      writes.push({ ...items });
      Object.assign(data, items);
    },
  };
  return { stub, data, writes };
}

const validState: AgentProfilesState = {
  agents: [
    {
      id: 'page-qa',
      name: '页面问答助手',
      description: 'd',
      rules: { inheritGlobal: true, items: [{ id: 'r1', text: 't' }] },
      skills: [],
  mcps: [],
    },
  ],
  activeAgentId: 'page-qa',
};

let storage: ReturnType<typeof createStorageStub>;

beforeEach(() => {
  storage = createStorageStub();
});

describe('createAgentProfileStore', () => {
  it('首次加载（存储为空）：迁移出内置三智能体并落盘，默认激活「通用智能体」', async () => {
    const store = createAgentProfileStore(storage.stub);
    await store.load('旧系统提示词');
    expect(store.agents.value.map((item) => item.id)).toEqual(['tool-debug', 'multi-turn-loop', 'a2a-analyst']);
    expect(store.activeAgentId.value).toBe(DEFAULT_ACTIVE_AGENT_ID);
    expect(store.activeAgent.value?.name).toBe('通用智能体');
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]![AGENT_PROFILES_STORAGE_KEY]).toMatchObject({ activeAgentId: DEFAULT_ACTIVE_AGENT_ID });
  });

  it('二次加载（已有智能体）：幂等不落盘，状态原样恢复', async () => {
    const first = createAgentProfileStore(storage.stub);
    await first.load('旧提示');
    const writesAfterFirst = storage.writes.length;
    const second = createAgentProfileStore(storage.stub);
    await second.load('旧提示');
    expect(second.agents.value).toHaveLength(3);
    expect(second.activeAgentId.value).toBe(DEFAULT_ACTIVE_AGENT_ID);
    expect(storage.writes.length).toBe(writesAfterFirst);
  });

  it('存储脏数据：先备份 agentProfiles.corrupt 再重建落盘', async () => {
    storage = createStorageStub({ [AGENT_PROFILES_STORAGE_KEY]: { agents: 'not-an-array' } });
    const store = createAgentProfileStore(storage.stub);
    await store.load('旧提示');
    expect(store.agents.value).toHaveLength(3);
    // 出厂状态：首个条目仍是 tool-debug，默认激活的是通用智能体（a2a-analyst）
    expect(store.agents.value[0]!.id).toBe('tool-debug');
    expect(store.activeAgentId.value).toBe(DEFAULT_ACTIVE_AGENT_ID);
    // 第一次写入 = 脏数据备份，第二次写入 = 重建后的出厂状态
    expect(storage.writes).toHaveLength(2);
    expect(storage.writes[0]![AGENT_PROFILES_CORRUPT_KEY]).toMatchObject({ value: { agents: 'not-an-array' } });
    expect(storage.writes[1]![AGENT_PROFILES_STORAGE_KEY]).toMatchObject({ activeAgentId: DEFAULT_ACTIVE_AGENT_ID });
  });

  it('setActive：更新响应式状态并持久化', async () => {
    storage = createStorageStub({ [AGENT_PROFILES_STORAGE_KEY]: validState });
    const store = createAgentProfileStore(storage.stub);
    await store.load('旧提示');
    expect(store.activeAgent.value?.id).toBe('page-qa');
    await store.setActive(DEFAULT_ACTIVE_AGENT_ID);
    expect(store.activeAgentId.value).toBe(DEFAULT_ACTIVE_AGENT_ID);
    // load 时迁移（追加缺失内置智能体）落盘一次 + setActive 一次
    expect(storage.writes).toHaveLength(2);
    const saved = storage.writes[1]![AGENT_PROFILES_STORAGE_KEY] as AgentProfilesState;
    expect(saved.activeAgentId).toBe(DEFAULT_ACTIVE_AGENT_ID);
    // 用户自定义条目保留在首位，其后为追加的内置智能体
    expect(saved.agents[0]).toEqual(validState.agents[0]);
    expect(saved.agents.map((item) => item.id)).toEqual([
      'page-qa',
      'tool-debug',
      'multi-turn-loop',
      'a2a-analyst',
    ]);
  });

  it('load 后 activeAgent 对 activeAgentId 未命中回落第一个', async () => {
    storage = createStorageStub({
      [AGENT_PROFILES_STORAGE_KEY]: { ...validState, activeAgentId: 'missing' },
    });
    const store = createAgentProfileStore(storage.stub);
    await store.load('旧提示');
    expect(store.activeAgent.value?.id).toBe('page-qa');
  });
});
