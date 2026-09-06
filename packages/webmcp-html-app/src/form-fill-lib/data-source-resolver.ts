// 时效性动态数据源解析器（页面侧适配版）。
// 移植自 docs/webmcp-form-fill.md 的「短TTL + 合并请求 + 执行时复核」策略：
//   - TTL 缓存：读与预校验走缓存
//   - 单飞（single-flight）：并发请求合并为一次 loader 调用
//   - SWR：过期但在 maxAge 内，返回旧值并后台刷新
//   - forceFresh / freshRequired：写操作前跳过缓存，强制最新（铁律 1 的页面侧落地）
//   - markStale / invalidateParams / cleanup：显式失效与内存回收
//
// 约束：erasableSyntaxOnly（禁用 enum/namespace/参数属性），全部用显式字段声明。

import type { DataSourceOption } from './types';

export type DataSourceLoader<P extends object> = (params: P) => Promise<DataSourceOption[]>;

export interface DataSourceConfig<P extends object = Record<string, never>> {
  name: string;
  loader: DataSourceLoader<P>;
  /** TTL 秒：缓存有效期。过期后进入 SWR（后台刷新同时返回旧值）。 */
  ttlSec: number;
  /** 最大存活秒：超过后缓存直接失效（前台等待新值，不再返回旧值）。默认 = ttlSec。 */
  maxAgeSec?: number;
  /** 强时效：跳过 SWR，每次 get 强制走最新数据。 */
  freshRequired?: boolean;
  /** 单飞 / 加载超时（毫秒），防止 loader 卡死导致永久 pending。默认 10000。 */
  flightTimeoutMs?: number;
}

export interface ResolveOptions {
  /** 强制刷新，跳过缓存与 SWR。 */
  forceFresh?: boolean;
  /** 旧值 SWR 开关，默认 true。设为 false 可强制前台等待新值。 */
  swr?: boolean;
}

interface CacheSlot {
  value: DataSourceOption[];
  fetchedAt: number;
  lastAccessAt: number;
  stale: boolean;
  flight: Promise<DataSourceOption[]> | null;
}

/** 稳定序列化 params，作为缓存隔离键。无参或空对象 => 单槽 __default__。 */
function stableKey(params: object | undefined): string {
  if (!params || Object.keys(params).length === 0) return '__default__';
  const sorted = Object.keys(params).sort();
  return JSON.stringify(params, sorted);
}

export class DataSourceResolver {
  private readonly sources = new Map<string, DataSourceConfig<any>>();
  private readonly cache = new Map<string, Map<string, CacheSlot>>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  register<P extends object>(config: DataSourceConfig<P>): DataSourceInstance<P> {
    this.sources.set(config.name, config as DataSourceConfig<any>);
    return new DataSourceInstance<P>(this, config.name);
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  async resolveOptions(
    name: string,
    params: object = {},
    opts: ResolveOptions = {},
  ): Promise<DataSourceOption[]> {
    const slot = await this.load(name, params, opts);
    return slot.value;
  }

  /** 读取缓存选项（不触发加载），无缓存返回 null。 */
  peekOptions(name: string, params: object = {}): DataSourceOption[] | null {
    const slot = this.slotOf(name, params);
    return slot && slot.fetchedAt !== 0 ? slot.value : null;
  }

  /** 数据获取距今秒数（新鲜度），无缓存返回 null。 */
  peekFreshnessSec(name: string, params: object = {}): number | null {
    const slot = this.slotOf(name, params);
    if (!slot || slot.fetchedAt === 0) return null;
    return Math.max(0, Math.round((this.now() - slot.fetchedAt) / 1000));
  }

  /** 全量或单数据源标记 stale，下次 get 走强制刷新（单飞）。 */
  markStale(name?: string): void {
    if (name) {
      this.cache.get(name)?.forEach((s) => {
        s.stale = true;
      });
    } else {
      this.cache.forEach((m) => m.forEach((s) => {
        s.stale = true;
      }));
    }
  }

  /** 精确失效：不传 params 清空整个数据源缓存；传 params 仅失效对应参数槽。 */
  invalidateParams(name: string, params?: object): void {
    const m = this.cache.get(name);
    if (!m) return;
    if (params === undefined) {
      m.clear();
      return;
    }
    m.delete(stableKey(params));
  }

  /** 按 lastAccessAt 清理空闲超过 maxIdleSec 的缓存槽，返回清理数量。 */
  cleanup(maxIdleSec: number): number {
    const now = this.now();
    let removed = 0;
    this.cache.forEach((m) => {
      for (const [k, slot] of m) {
        if ((now - slot.lastAccessAt) / 1000 > maxIdleSec) {
          m.delete(k);
          removed++;
        }
      }
    });
    return removed;
  }

  private slotOf(name: string, params: object): CacheSlot | undefined {
    return this.cache.get(name)?.get(stableKey(params));
  }

  private getConfig(name: string): DataSourceConfig<any> {
    const c = this.sources.get(name);
    if (!c) throw new Error(`未注册的数据源: ${name}`);
    return c;
  }

  private async load(name: string, params: object, opts: ResolveOptions): Promise<CacheSlot> {
    const cfg = this.getConfig(name);
    let m = this.cache.get(name);
    if (!m) {
      m = new Map();
      this.cache.set(name, m);
    }
    const key = stableKey(params);
    let slot = m.get(key);
    if (!slot) {
      slot = { value: [], fetchedAt: 0, lastAccessAt: this.now(), stale: true, flight: null };
      m.set(key, slot);
    }

    const ageMs = this.now() - slot.fetchedAt;
    const ttlMs = cfg.ttlSec * 1000;
    const maxAgeMs = (cfg.maxAgeSec ?? cfg.ttlSec) * 1000;
    const forceFresh = opts.forceFresh === true || cfg.freshRequired === true;
    const expired = ageMs > maxAgeMs;
    const hasValue = slot.fetchedAt !== 0;
    const withinTtl = hasValue && ageMs <= ttlMs;
    const mustReload = forceFresh || slot.stale || expired || !hasValue;

    slot.lastAccessAt = this.now();

    // 单飞：复用进行中的加载
    if (slot.flight) {
      await slot.flight;
      return slot;
    }

    // 新鲜缓存直接返回
    if (!mustReload && withinTtl) {
      return slot;
    }

    // SWR：命中旧值但已过 TTL —— 立即返回旧值，后台刷新
    if (hasValue && !forceFresh && !slot.stale && !expired) {
      const fp = this.runLoader(cfg, params, slot);
      slot.flight = fp;
      fp.finally(() => {
        if (slot.flight === fp) slot.flight = null;
      }).catch(() => {});
      return slot;
    }

    // 前台刷新：首载 / 强制 / 过期 / 失效 —— 等待新值
    const fp = this.runLoader(cfg, params, slot);
    slot.flight = fp;
    try {
      await fp;
    } finally {
      slot.flight = null;
    }
    return slot;
  }

  private runLoader(
    cfg: DataSourceConfig<any>,
    params: object,
    slot: CacheSlot,
  ): Promise<DataSourceOption[]> {
    const timeoutMs = cfg.flightTimeoutMs ?? 10000;
    const timer = new Promise<DataSourceOption[]>((_, reject) =>
      setTimeout(() => reject(new Error(`数据源加载超时: ${cfg.name}`)), timeoutMs),
    );
    const raced = Promise.race([cfg.loader(params), timer]);
    return raced.then((v) => {
      slot.value = v;
      slot.fetchedAt = this.now();
      slot.stale = false;
      return v;
    });
  }
}

/** 带类型参数 P 的数据源句柄，便于业务侧强类型访问。 */
export class DataSourceInstance<P extends object = Record<string, never>> {
  private readonly resolver: DataSourceResolver;
  public readonly name: string;

  constructor(resolver: DataSourceResolver, name: string) {
    this.resolver = resolver;
    this.name = name;
  }

  resolve(params: P, opts: ResolveOptions = {}): Promise<DataSourceOption[]> {
    return this.resolver.resolveOptions(this.name, params, opts);
  }

  freshnessSec(params: P): number | null {
    return this.resolver.peekFreshnessSec(this.name, params);
  }

  markStale(): void {
    this.resolver.markStale(this.name);
  }

  invalidate(params?: P): void {
    this.resolver.invalidateParams(this.name, params);
  }
}

// ---- 全局注册表：demo 便捷入口。业务侧也可独立 new DataSourceResolver() 使用。 ----
const globalResolver = new DataSourceResolver();

export function registerDataSource<P extends object>(config: DataSourceConfig<P>): DataSourceInstance<P> {
  return globalResolver.register(config);
}

export function getGlobalResolver(): DataSourceResolver {
  return globalResolver;
}
