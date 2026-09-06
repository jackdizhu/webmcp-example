// DataSourceResolver 单测：TTL / SWR / 单飞 / forceFresh / params 隔离 / markStale / invalidate / cleanup / freshness。
// 不依赖 fake timers（参考 issues/006），统一通过可注入时钟 now() 控制时间。
import { describe, it, expect, vi } from 'vitest';
import { DataSourceResolver } from './data-source-resolver';
import type { DataSourceOption } from './types';

describe('DataSourceResolver', () => {
  it('首次加载并缓存，TTL 内命中不重复加载', async () => {
    const clock = { t: 1000 };
    const loader = vi.fn(async () => [{ value: 'a', label: 'A' }] as DataSourceOption[]);
    const r = new DataSourceResolver({ now: () => clock.t });
    r.register({ name: 'x', ttlSec: 60, loader });
    const o1 = await r.resolveOptions('x', {});
    expect(o1).toEqual([{ value: 'a', label: 'A' }]);
    expect(loader).toHaveBeenCalledTimes(1);
    clock.t += 10_000; // 10s < 60s TTL
    const o2 = await r.resolveOptions('x', {});
    expect(o2).toEqual([{ value: 'a', label: 'A' }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('SWR：过 TTL 但在 maxAge 内，先返回旧值并后台刷新为新值', async () => {
    const clock = { t: 1000 };
    let n = 0;
    const loader = vi.fn(async () => {
      n += 1;
      return [{ value: 'v' + n, label: 'L' + n }] as DataSourceOption[];
    });
    const r = new DataSourceResolver({ now: () => clock.t });
    r.register({ name: 'x', ttlSec: 60, maxAgeSec: 300, loader });
    const o1 = await r.resolveOptions('x', {});
    expect(o1[0].value).toBe('v1');
    clock.t += 70_000; // 70s > 60 ttl, < 300 maxAge
    const stale = await r.resolveOptions('x', {}); // 返回旧值 v1
    expect(stale[0].value).toBe('v1');
    expect(loader).toHaveBeenCalledTimes(2); // 后台已触发刷新
    await new Promise((res) => setTimeout(res, 0));
    expect(r.peekOptions('x', {})![0].value).toBe('v2'); // 缓存已被后台更新
  });

  it('forceFresh 跳过缓存', async () => {
    const clock = { t: 1000 };
    const loader = vi.fn(async () => [{ value: 'a', label: 'A' }] as DataSourceOption[]);
    const r = new DataSourceResolver({ now: () => clock.t });
    r.register({ name: 'x', ttlSec: 60, loader });
    await r.resolveOptions('x', {});
    clock.t += 1000;
    await r.resolveOptions('x', {}, { forceFresh: true });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('单飞：并发请求合并为一次 loader 调用', async () => {
    let calls = 0;
    let resolveLoader: (v: DataSourceOption[]) => void = () => {};
    const loader = (): Promise<DataSourceOption[]> => {
      calls += 1;
      return new Promise<DataSourceOption[]>((res) => {
        resolveLoader = res;
      });
    };
    const r = new DataSourceResolver();
    r.register({ name: 'x', ttlSec: 60, loader });
    const p1 = r.resolveOptions('x', {});
    const p2 = r.resolveOptions('x', {});
    expect(calls).toBe(1); // 合并
    resolveLoader([{ value: 'a', label: 'A' }]);
    await p1;
    await p2;
    expect(calls).toBe(1);
  });

  it('params 维度隔离', async () => {
    const loader = vi.fn(async (p: object) => [{ value: JSON.stringify(p), label: 'x' }] as DataSourceOption[]);
    const r = new DataSourceResolver();
    r.register({ name: 'p', ttlSec: 60, loader });
    const a = await r.resolveOptions('p', { sku: 'A' });
    const b = await r.resolveOptions('p', { sku: 'B' });
    expect(a[0].value).toBe('{"sku":"A"}');
    expect(b[0].value).toBe('{"sku":"B"}');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('markStale 触发下次前台刷新', async () => {
    const clock = { t: 1000 };
    const loader = vi.fn(async () => [{ value: 'a', label: 'A' }] as DataSourceOption[]);
    const r = new DataSourceResolver({ now: () => clock.t });
    r.register({ name: 'x', ttlSec: 60, loader });
    await r.resolveOptions('x', {}); // 1
    clock.t += 1000;
    r.markStale('x');
    await r.resolveOptions('x', {}); // 2
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidateParams 清空指定参数槽', async () => {
    const loader = vi.fn(async (p: object) => [{ value: JSON.stringify(p), label: 'x' }] as DataSourceOption[]);
    const r = new DataSourceResolver();
    r.register({ name: 'p', ttlSec: 60, loader });
    await r.resolveOptions('p', { sku: 'A' });
    r.invalidateParams('p', { sku: 'A' });
    expect(r.peekOptions('p', { sku: 'A' })).toBeNull();
    await r.resolveOptions('p', { sku: 'A' }); // 重新加载
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('cleanup 按空闲时间回收缓存槽', async () => {
    const clock = { t: 1000 };
    const loader = vi.fn(async () => [{ value: 'a', label: 'A' }] as DataSourceOption[]);
    const r = new DataSourceResolver({ now: () => clock.t });
    r.register({ name: 'x', ttlSec: 60, loader });
    await r.resolveOptions('x', {});
    clock.t += 200_000; // 200s 空闲
    const removed = r.cleanup(100); // maxIdle 100s
    expect(removed).toBe(1);
    expect(r.peekOptions('x', {})).toBeNull();
  });

  it('peekFreshnessSec 反映新鲜度', async () => {
    const clock = { t: 1000 };
    const loader = vi.fn(async () => [{ value: 'a', label: 'A' }] as DataSourceOption[]);
    const r = new DataSourceResolver({ now: () => clock.t });
    r.register({ name: 'x', ttlSec: 60, loader });
    expect(r.peekFreshnessSec('x', {})).toBeNull();
    await r.resolveOptions('x', {}); // fetchedAt = 1000
    expect(r.peekFreshnessSec('x', {})).toBe(0);
    clock.t += 5000;
    expect(r.peekFreshnessSec('x', {})).toBe(5);
  });

  it('freshRequired 数据源每次强制刷新', async () => {
    const loader = vi.fn(async () => [{ value: 'a', label: 'A' }] as DataSourceOption[]);
    const r = new DataSourceResolver();
    r.register({ name: 'x', ttlSec: 60, freshRequired: true, loader });
    await r.resolveOptions('x', {});
    await r.resolveOptions('x', {});
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
