// session-core 单测：ID/标题生成与排序截取纯函数（无 IndexedDB 依赖，jsdom 可跑）。
import { describe, expect, it, vi } from 'vitest';
import {
  createSessionId,
  deriveSessionTitle,
  evictionIds,
  SESSION_TITLE_MAX_LENGTH,
  sliceRecent,
  trimSessions,
  type StoredChatSession,
} from './session-core';

/** 组装一条会话（updatedAt 为主要排序维度）。 */
function makeSession(id: string, updatedAt: number): StoredChatSession {
  return {
    id,
    title: `标题${id}`,
    agentId: 'agent-1',
    createdAt: updatedAt - 1000,
    updatedAt,
    messages: [],
    llmHistory: [],
  };
}

describe('createSessionId', () => {
  it('格式：sess_<时间戳base36>_<6位随机>', () => {
    const fixedRandom = vi.fn(() => 0.5); // 恒定随机 → floor(0.5*36)=18 → 字母表第 18 位 's'
    const id = createSessionId(1700000000000, fixedRandom);
    expect(id).toBe(`sess_${(1700000000000).toString(36)}_ssssss`);
  });

  it('随机源不同则后缀不同；时间戳相同前缀一致', () => {
    let flip = false;
    const a = createSessionId(1000, () => {
      flip = !flip;
      return flip ? 0.1 : 0.9;
    });
    const b = createSessionId(1000, () => 0.5);
    expect(a.startsWith('sess_')).toBe(true);
    expect(b.startsWith('sess_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('deriveSessionTitle', () => {
  it('trim 后截断到上限长度', () => {
    const long = `  ${'很'.repeat(SESSION_TITLE_MAX_LENGTH + 5)}  `;
    expect(deriveSessionTitle(long)).toHaveLength(SESSION_TITLE_MAX_LENGTH);
  });

  it('短文案原样保留（去首尾空白）；空/纯空白返回空串', () => {
    expect(deriveSessionTitle('  列出页面工具  ')).toBe('列出页面工具');
    expect(deriveSessionTitle('   ')).toBe('');
    expect(deriveSessionTitle('')).toBe('');
  });
});

describe('trimSessions / sliceRecent', () => {
  const sessions = [
    makeSession('old-1', 100),
    makeSession('mid', 200),
    makeSession('new-1', 300),
    makeSession('new-2', 400),
  ];

  it('trimSessions 按 updatedAt 降序保留最近 limit 条', () => {
    const kept = trimSessions(sessions, 2);
    expect(kept.map((s) => s.id)).toEqual(['new-2', 'new-1']);
  });

  it('trimSessions limit 覆盖全部时原序反转（降序）且不突变入参', () => {
    const kept = trimSessions(sessions, 10);
    expect(kept.map((s) => s.id)).toEqual(['new-2', 'new-1', 'mid', 'old-1']);
    expect(sessions).toHaveLength(4); // 入参未被重排
  });

  it('trimSessions limit 非正整数/非整数时兜底返回空数组', () => {
    expect(trimSessions(sessions, 0)).toEqual([]);
    expect(trimSessions(sessions, -1)).toEqual([]);
    expect(trimSessions(sessions, 1.5)).toEqual([]);
  });

  it('sliceRecent 与 trimSessions 同序同截取（语义分场景命名）', () => {
    expect(sliceRecent(sessions, 3).map((s) => s.id)).toEqual(['new-2', 'new-1', 'mid']);
    expect(sliceRecent(sessions, 0)).toEqual([]);
  });

  it('updatedAt 相同的会话保持原序（稳定排序）', () => {
    const tied = [makeSession('a', 100), makeSession('b', 100), makeSession('c', 50)];
    expect(trimSessions(tied, 3).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('evictionIds', () => {
  const sessions = [
    makeSession('old-1', 100),
    makeSession('mid', 200),
    makeSession('new-1', 300),
    makeSession('new-2', 400),
  ];

  it('与 trimSessions 互补：保留集合之外全部淘汰（最旧优先出局）', () => {
    expect(evictionIds(sessions, 2)).toEqual(['old-1', 'mid']);
    expect(evictionIds(sessions, 4)).toEqual([]);
  });

  it('limit 覆盖全部时不淘汰任何记录（含刚写入的最新会话）', () => {
    const withIncoming = [...sessions, makeSession('incoming', 500)];
    expect(evictionIds(withIncoming, 5)).toEqual([]);
  });

  it('limit 非正整数/非整数时全删（与 trimSessions 空数组语义一致）', () => {
    expect(evictionIds(sessions, 0)).toEqual(['old-1', 'mid', 'new-1', 'new-2']);
    expect(evictionIds(sessions, -1)).toEqual(['old-1', 'mid', 'new-1', 'new-2']);
    expect(evictionIds(sessions, 1.5)).toEqual(['old-1', 'mid', 'new-1', 'new-2']);
  });

  it('保留/淘汰集合与 trimSessions 严格互补（不变式校验）', () => {
    for (const limit of [0, 1, 2, 3, 4, 10]) {
      const kept = trimSessions(sessions, limit).map((s) => s.id);
      const evicted = evictionIds(sessions, limit);
      expect([...kept, ...evicted].sort()).toEqual(sessions.map((s) => s.id).sort());
      expect(kept.filter((id) => evicted.includes(id))).toEqual([]);
    }
  });
});
