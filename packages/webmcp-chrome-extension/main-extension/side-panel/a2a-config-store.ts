// 全局 A2A 配置存储（side-panel，2026-09-14 解耦改造）。
//
// 职责：把全局单份的 A2A 远程智能体配置（AgentA2aRef[]）持久化到
// chrome.storage.local 独立键 `a2aConfig`（不再寄生 agentProfiles）——
// - load：严格校验读取；**首次缺失时从旧 agentProfiles 一次性防御式迁移**（按 id
//   全局去重，非法条目丢弃计数）；脏数据先备份 `a2aConfig.corrupt` 再重建空表，
//   杜绝「校验失败 → 静默覆盖用户配置」（agent-profile-store 历史缺陷）；
// - save：严格校验后整体覆盖写。
// token 仍在 a2aTokens 键（a2a-host.ts 持有），不入本键（安全立场不变）。
import {
  sanitizeA2aRefs,
  validateA2aConfigValue,
  type AgentA2aRef,
} from 'webmcp-agent-chat-core';

/** chrome.storage.local 的最小结构面（便于测试注入桩）。 */
export interface A2aConfigStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** 全局 A2A 配置的持久化键。 */
export const A2A_CONFIG_STORAGE_KEY = 'a2aConfig';
/** 脏数据备份键（保留最近一次校验失败的原始值，bounded，不无限累积）。 */
export const A2A_CONFIG_CORRUPT_KEY = 'a2aConfig.corrupt';
/** 旧档案键（迁移来源，只读）。 */
export const AGENT_PROFILES_RAW_KEY = 'agentProfiles';

function defaultStorage(): A2aConfigStorageLike {
  return chrome.storage.local as unknown as A2aConfigStorageLike;
}

/** loadA2aConfig 结果：refs 为可用配置；migrated/corrupted/migratedDropped 供宿主打日志与提示。 */
export interface A2aConfigLoadResult {
  refs: AgentA2aRef[];
  /** 本次发生了一次性迁移（旧 agentProfiles → a2aConfig）且已落盘。 */
  migrated: boolean;
  /** 迁移中丢弃的非法/重复条目数。 */
  migratedDropped: number;
  /** 存储脏数据：原始值已备份到 a2aConfig.corrupt，本次重建为空表。 */
  corrupted: boolean;
}

/** 从旧 agentProfiles 原始值中防御式提取全部 a2aAgents（跨智能体按 id 全局去重）。 */
function extractLegacyA2aRefs(profiles: unknown): { refs: AgentA2aRef[]; dropped: number } {
  if (typeof profiles !== 'object' || profiles === null) return { refs: [], dropped: 0 };
  const agents = (profiles as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return { refs: [], dropped: 0 };
  const seen = new Set<string>();
  const refs: AgentA2aRef[] = [];
  let dropped = 0;
  for (const agent of agents) {
    const raw = typeof agent === 'object' && agent !== null ? (agent as { a2aAgents?: unknown }).a2aAgents : undefined;
    const part = sanitizeA2aRefs(raw);
    dropped += part.dropped;
    for (const item of part.refs) {
      if (seen.has(item.id)) {
        dropped += 1;
        continue;
      }
      seen.add(item.id);
      refs.push(item);
    }
  }
  return { refs, dropped };
}

/** 读取全局 A2A 配置（含一次性迁移与脏数据备份，语义见模块头注释）。 */
export async function loadA2aConfig(
  storage: A2aConfigStorageLike = defaultStorage()
): Promise<A2aConfigLoadResult> {
  const stored = await storage.get([A2A_CONFIG_STORAGE_KEY, AGENT_PROFILES_RAW_KEY]);
  const raw = stored[A2A_CONFIG_STORAGE_KEY];
  if (raw !== undefined) {
    try {
      return { refs: validateA2aConfigValue(raw), migrated: false, migratedDropped: 0, corrupted: false };
    } catch {
      // 先备份原始值再重建：重建写空表，避免每次加载重复备份同一份脏数据
      await storage.set({ [A2A_CONFIG_CORRUPT_KEY]: { at: new Date().toISOString(), value: raw } });
      await storage.set({ [A2A_CONFIG_STORAGE_KEY]: [] });
      return { refs: [], migrated: false, migratedDropped: 0, corrupted: true };
    }
  }
  // 首次加载：从旧档案一次性迁移（仅在有可迁移数据时落盘，空结果不产生写入）
  const legacy = extractLegacyA2aRefs(stored[AGENT_PROFILES_RAW_KEY]);
  if (legacy.refs.length > 0) {
    await storage.set({ [A2A_CONFIG_STORAGE_KEY]: legacy.refs });
  }
  return {
    refs: legacy.refs,
    migrated: legacy.refs.length > 0,
    migratedDropped: legacy.dropped,
    corrupted: false,
  };
}

/** 持久化全局 A2A 配置（整体覆盖写；先严格校验，非法配置抛错不落盘）。 */
export async function saveA2aConfig(
  refs: AgentA2aRef[],
  storage: A2aConfigStorageLike = defaultStorage()
): Promise<void> {
  // JSON 快照：剥离 Vue 响应式代理，且与校验通过的形状逐字段对齐
  const snapshot = JSON.parse(JSON.stringify(refs)) as AgentA2aRef[];
  validateA2aConfigValue(snapshot);
  await storage.set({ [A2A_CONFIG_STORAGE_KEY]: snapshot });
}

/** refs → 待持久化快照（逐字段显式列出；2026-09-16 协议扩展：新增 protocol 与 dify 专属字段，
 *  白名单缺失字段会被保存链路静默丢弃，新增 AgentA2aRef 字段时必须同步扩展本函数）。 */
export function toA2aConfigSnapshot(refs: AgentA2aRef[]): AgentA2aRef[] {
  return refs.map((item) => {
    const out: AgentA2aRef = { id: item.id, enabled: item.enabled };
    if (item.cardUrl !== undefined) out.cardUrl = item.cardUrl;
    if (item.protocol !== undefined) out.protocol = item.protocol;
    if (item.endpointOverride !== undefined) out.endpointOverride = item.endpointOverride;
    if (item.endpoint !== undefined) out.endpoint = item.endpoint;
    if (item.responseMode !== undefined) out.responseMode = item.responseMode;
    if (item.displayName !== undefined) out.displayName = item.displayName;
    if (item.description !== undefined) out.description = item.description;
    if (item.inputs !== undefined) out.inputs = item.inputs;
    return out;
  });
}
