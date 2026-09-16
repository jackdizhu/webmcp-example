// a2a-config-store 单测：独立键读写 + 一次性迁移 + 脏数据备份重建（storage 桩注入，无 chrome 全局）。
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentA2aRef } from 'webmcp-agent-chat-core';
import {
  A2A_CONFIG_CORRUPT_KEY,
  A2A_CONFIG_STORAGE_KEY,
  AGENT_PROFILES_RAW_KEY,
  loadA2aConfig,
  saveA2aConfig,
  toA2aConfigSnapshot,
  type A2aConfigStorageLike,
} from './a2a-config-store';

/** 可编程 storage 桩：追加式写入记录，get 返回当前数据快照。 */
function createStorageStub(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const writes: Array<Record<string, unknown>> = [];
  const stub: A2aConfigStorageLike = {
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

const refs: AgentA2aRef[] = [
  { id: 'dify_app', cardUrl: 'https://x.example.com/card.json', enabled: true },
  { id: 'doc-agent', cardUrl: 'https://y.example.com/card.json', enabled: false, endpointOverride: 'http://localhost/e/app/a2a' },
];

let storage: ReturnType<typeof createStorageStub>;

beforeEach(() => {
  storage = createStorageStub();
});

describe('loadA2aConfig', () => {
  it('首次加载（a2aConfig 缺失、旧档案无绑定）：空表、无迁移、无写入', async () => {
    storage = createStorageStub({
      [AGENT_PROFILES_RAW_KEY]: { agents: [{ id: 'a' }], activeAgentId: 'a' },
    });
    const result = await loadA2aConfig(storage.stub);
    expect(result).toEqual({ refs: [], migrated: false, migratedDropped: 0, corrupted: false });
    expect(storage.writes).toHaveLength(0);
  });

  it('首次加载：旧档案各智能体的 a2aAgents 一次性迁移合并落盘（跨智能体按 id 去重）', async () => {
    storage = createStorageStub({
      [AGENT_PROFILES_RAW_KEY]: {
        agents: [
          { id: 'tool-debug', a2aAgents: [refs[0]] },
          { id: 'a2a-analyst', a2aAgents: [refs[0], refs[1], { id: 'bad' }] },
        ],
        activeAgentId: 'tool-debug',
      },
    });
    const result = await loadA2aConfig(storage.stub);
    expect(result.migrated).toBe(true);
    expect(result.refs).toEqual(refs);
    expect(result.migratedDropped).toBe(2);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]![A2A_CONFIG_STORAGE_KEY]).toEqual(refs);
    // 幂等：二次加载直接读 a2aConfig，不再迁移
    const second = await loadA2aConfig(storage.stub);
    expect(second.migrated).toBe(false);
    expect(second.refs).toEqual(refs);
  });

  it('存储脏数据：先备份 a2aConfig.corrupt 再重建空表落盘', async () => {
    storage = createStorageStub({ [A2A_CONFIG_STORAGE_KEY]: { agents: 'not-an-array' } });
    const result = await loadA2aConfig(storage.stub);
    expect(result.corrupted).toBe(true);
    expect(result.refs).toEqual([]);
    expect(storage.writes).toHaveLength(2);
    expect(storage.writes[0]![A2A_CONFIG_CORRUPT_KEY]).toMatchObject({ value: { agents: 'not-an-array' } });
    expect(storage.writes[1]![A2A_CONFIG_STORAGE_KEY]).toEqual([]);
    // 重建后二次加载正常（不再触发备份）
    const second = await loadA2aConfig(storage.stub);
    expect(second.corrupted).toBe(false);
    expect(second.refs).toEqual([]);
  });
});

describe('saveA2aConfig', () => {
  it('合法配置覆盖落盘（JSON 快照剥离响应式代理）', async () => {
    await saveA2aConfig(refs, storage.stub);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]![A2A_CONFIG_STORAGE_KEY]).toEqual(refs);
  });

  it('非法配置抛错不落盘', async () => {
    await expect(saveA2aConfig([{ id: '', cardUrl: '', enabled: true }], storage.stub)).rejects.toThrow(
      'invalid a2a config'
    );
    expect(storage.writes).toHaveLength(0);
  });
});

describe('toA2aConfigSnapshot', () => {
  it('逐字段快照：无端点覆盖时移除可选字段（exactOptionalPropertyTypes 语义；键序无关）', () => {
    expect(toA2aConfigSnapshot(refs)).toEqual(refs);
    expect(Object.keys(toA2aConfigSnapshot(refs)[0]!).sort()).toEqual(['id', 'cardUrl', 'enabled'].sort());
    expect(Object.keys(toA2aConfigSnapshot(refs)[1]!).sort()).toEqual(
      ['id', 'cardUrl', 'enabled', 'endpointOverride'].sort()
    );
  });

  it('dify 条目：协议与 dify 专属字段全部保留（白名单遗漏会静默丢字段）', () => {
    const difyRefs: AgentA2aRef[] = [
      {
        id: 'weather',
        enabled: true,
        protocol: 'dify',
        endpoint: 'https://api.dify.example.com/v1/chat-messages',
        responseMode: 'blocking',
        displayName: '天气助手',
        description: '查询城市天气',
        inputs: { city: '北京' },
      },
      { id: 'minimal', enabled: false, protocol: 'dify', endpoint: 'https://x/v1/chat-messages' },
    ];
    expect(toA2aConfigSnapshot(difyRefs)).toEqual(difyRefs);
    expect(Object.keys(toA2aConfigSnapshot(difyRefs)[0]!).sort()).toEqual(
      ['id', 'enabled', 'protocol', 'endpoint', 'responseMode', 'displayName', 'description', 'inputs'].sort()
    );
    expect(Object.keys(toA2aConfigSnapshot(difyRefs)[1]!).sort()).toEqual(
      ['id', 'enabled', 'protocol', 'endpoint'].sort()
    );
  });

  it('jsonrpc 条目显式 protocol 保留；旧数据（无 protocol）快照不带该字段', () => {
    const withProtocol: AgentA2aRef[] = [{ id: 'a', cardUrl: 'https://x/card.json', enabled: true, protocol: 'jsonrpc' }];
    expect(toA2aConfigSnapshot(withProtocol)).toEqual(withProtocol);
    expect(toA2aConfigSnapshot(refs)[0]).not.toHaveProperty('protocol');
  });
});
