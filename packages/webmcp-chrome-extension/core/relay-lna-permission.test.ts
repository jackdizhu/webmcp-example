import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryLoopbackPermission } from './relay-lna-permission';

type QueryFn = (description: { name: string }) => Promise<{ state: string }>;

/** 注入 navigator.permissions 桩（undefined 表示整个 permissions 不存在）。 */
function stubPermissions(query: QueryFn | undefined): void {
  vi.stubGlobal('navigator', query ? { permissions: { query } } : {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queryLoopbackPermission', () => {
  it('Chrome 145+：loopback-network 命中直接返回其状态', async () => {
    stubPermissions(
      vi.fn(async ({ name }) => {
        expect(name).toBe('loopback-network');
        return { state: 'denied' };
      })
    );
    await expect(queryLoopbackPermission()).resolves.toBe('denied');
  });

  it('granted / prompt 状态原样透传', async () => {
    stubPermissions(vi.fn(async () => ({ state: 'prompt' })));
    await expect(queryLoopbackPermission()).resolves.toBe('prompt');
  });

  it('细粒度名未支持时回退到 local-network-access 兼容别名（Chrome 142-144）', async () => {
    stubPermissions(
      vi.fn(async ({ name }) => {
        if (name === 'loopback-network') {
          throw new TypeError(`Unsupported permission name: ${name}`);
        }
        return { state: 'granted' };
      })
    );
    await expect(queryLoopbackPermission()).resolves.toBe('granted');
  });

  it('两个名称都未支持 → unsupported', async () => {
    stubPermissions(
      vi.fn(async () => {
        throw new TypeError('Unsupported permission name');
      })
    );
    await expect(queryLoopbackPermission()).resolves.toBe('unsupported');
  });

  it('返回非标准 state 值 → 视为未支持并尝试别名后降级', async () => {
    stubPermissions(vi.fn(async () => ({ state: 'weird' })));
    await expect(queryLoopbackPermission()).resolves.toBe('unsupported');
  });

  it('运行环境无 navigator.permissions → unsupported', async () => {
    stubPermissions(undefined);
    await expect(queryLoopbackPermission()).resolves.toBe('unsupported');
  });
});
