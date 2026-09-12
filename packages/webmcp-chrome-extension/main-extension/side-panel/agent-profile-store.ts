// 智能体档案宿主存储（side-panel，P1 落地）。
//
// 职责：实现 core 的 ProfileStore 契约（chrome.storage.local 键 `agentProfiles`），
// 并以 Vue 响应式状态暴露给 App 接线层。本模块是纯粹的「平台适配器」——
// 领域逻辑（校验/迁移/组装）全部来自 webmcp-agent-chat-core（D5/C8 红线），
// 这里只做：读存储 → 校验 →（缺失/损坏时）幂等迁移 → 落盘 → 响应式暴露。
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import {
  getActiveAgent,
  migrateLegacySettings,
  validateAgentProfilesState,
  type AgentProfile,
  type ProfileStore,
} from 'webmcp-agent-chat-core';

/** chrome.storage.local 的最小结构面（便于测试注入桩）。 */
export interface ProfileStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** chrome.storage.local 中的持久化键。 */
export const AGENT_PROFILES_STORAGE_KEY = 'agentProfiles';

/** 默认存储实现：chrome.storage.local。 */
function defaultStorage(): ProfileStorageLike {
  return chrome.storage.local as unknown as ProfileStorageLike;
}

/** core ProfileStore 契约的 chrome.storage 适配实现（纯读写，不含领域逻辑）。 */
function createChromeProfileStore(storage: ProfileStorageLike): ProfileStore {
  return {
    async load() {
      const stored = await storage.get([AGENT_PROFILES_STORAGE_KEY]);
      const value = stored[AGENT_PROFILES_STORAGE_KEY];
      if (value === undefined) return null;
      try {
        return validateAgentProfilesState(value);
      } catch {
        // 存储脏数据：返回 null 交由迁移路径重建（不静默覆盖，由 load 流程统一落盘）
        return null;
      }
    },
    async save(state) {
      await storage.set({ [AGENT_PROFILES_STORAGE_KEY]: state });
    },
  };
}

/** 智能体档案 store（宿主侧响应式视图）。 */
export interface AgentProfileStore {
  /** 全部智能体档案（只读视图）。 */
  agents: Ref<AgentProfile[]>;
  /** 当前激活智能体 ID。 */
  activeAgentId: Ref<string>;
  /** 当前激活智能体（未命中回落第一个；空列表 = null）。 */
  activeAgent: ComputedRef<AgentProfile | null>;
  /**
   * 启动加载：读存储 →（缺失或脏数据时）用旧版 systemPrompt 幂等迁移 → 需要落盘时写回。
   * 幂等保证由 core 的 migrateLegacySettings 承担（已有智能体时原样返回，不重复创建）。
   */
  load(legacySystemPrompt: string): Promise<void>;
  /** 切换激活智能体（更新响应式状态并持久化）。 */
  setActive(id: string): Promise<void>;
}

export function createAgentProfileStore(
  storage: ProfileStorageLike = defaultStorage()
): AgentProfileStore {
  const backend = createChromeProfileStore(storage);
  const agents = ref<AgentProfile[]>([]);
  const activeAgentId = ref('');
  const activeAgent = computed(() =>
    getActiveAgent({ agents: agents.value, activeAgentId: activeAgentId.value })
  );

  return {
    agents,
    activeAgentId,
    activeAgent,
    async load(legacySystemPrompt) {
      const existing = await backend.load();
      const migrated = migrateLegacySettings({ systemPrompt: legacySystemPrompt }, existing);
      // 幂等迁移返回同一引用 = 无需落盘；新引用（首次/重建）才写回
      if (migrated !== existing) await backend.save(migrated);
      agents.value = migrated.agents;
      activeAgentId.value = migrated.activeAgentId;
    },
    async setActive(id) {
      activeAgentId.value = id;
      await backend.save({ agents: agents.value, activeAgentId: id });
    },
  };
}
