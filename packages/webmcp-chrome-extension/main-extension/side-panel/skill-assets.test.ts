// skill-assets 单测：内置清单摘要 + storage 覆写读取（含脏数据容错）。
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS, SKILL_OVERRIDES_STORAGE_KEY, createHostSkillSource, getBuiltinSkillSummary } from './skill-assets';
import type { ProfileStorageLike } from './agent-profile-store';

function createStorageStub(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const stub: ProfileStorageLike = {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
  };
  return { stub, data };
}

let storage: ReturnType<typeof createStorageStub>;

beforeEach(() => {
  storage = createStorageStub();
});

describe('BUILTIN_SKILLS / getBuiltinSkillSummary', () => {
  it('内置清单含 page-tools-guide，摘要含 keywords', () => {
    const summary = getBuiltinSkillSummary('page-tools-guide');
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe('页面工具使用指南');
    expect(summary!.keywords).toContain('工具');
  });

  it('未知 id 返回 null', () => {
    expect(getBuiltinSkillSummary('nope')).toBeNull();
  });

  it('内置技能定义自洽：摘要与全文同源、content 非空', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content.length).toBeGreaterThan(20);
      expect(getBuiltinSkillSummary(skill.id)!.name).toBe(skill.name);
    }
  });
});

describe('createHostSkillSource.loadAsset', () => {
  it('命中返回完整定义（含 content），未命中返回 null', async () => {
    const source = createHostSkillSource(storage.stub);
    const asset = await source.loadAsset('page-tools-guide');
    expect(asset!.content).toContain('chrome_extension_get_document_info');
    expect(await source.loadAsset('nope')).toBeNull();
  });
});

describe('createHostSkillSource.loadOverride', () => {
  const overrideEntry = {
    id: 'page-tools-guide',
    name: '覆写版指南',
    description: '用户自定义描述',
    content: '覆写版全文',
  };

  it('存在合法覆写时返回，且 id 与请求一致', async () => {
    storage = createStorageStub({ [SKILL_OVERRIDES_STORAGE_KEY]: { 'page-tools-guide': overrideEntry } });
    const source = createHostSkillSource(storage.stub);
    const result = await source.loadOverride('page-tools-guide');
    expect(result!.name).toBe('覆写版指南');
    expect(result!.content).toBe('覆写版全文');
  });

  it('无覆写键 / 非对象 map / 未知 id 返回 null', async () => {
    expect(await createHostSkillSource(storage.stub).loadOverride('page-tools-guide')).toBeNull();
    storage = createStorageStub({ [SKILL_OVERRIDES_STORAGE_KEY]: 'broken' });
    expect(await createHostSkillSource(storage.stub).loadOverride('page-tools-guide')).toBeNull();
    storage = createStorageStub({ [SKILL_OVERRIDES_STORAGE_KEY]: { 'other-id': overrideEntry } });
    expect(await createHostSkillSource(storage.stub).loadOverride('page-tools-guide')).toBeNull();
  });

  it('脏条目（缺 content / name 为空）容错返回 null', async () => {
    storage = createStorageStub({
      [SKILL_OVERRIDES_STORAGE_KEY]: {
        'page-tools-guide': { id: 'page-tools-guide', name: '', description: 'd', content: 'c' },
      },
    });
    expect(await createHostSkillSource(storage.stub).loadOverride('page-tools-guide')).toBeNull();
    storage = createStorageStub({
      [SKILL_OVERRIDES_STORAGE_KEY]: {
        'page-tools-guide': { id: 'page-tools-guide', name: 'n', description: 'd' },
      },
    });
    expect(await createHostSkillSource(storage.stub).loadOverride('page-tools-guide')).toBeNull();
  });
});
