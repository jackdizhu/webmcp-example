// A2A 宿主托管模块（side-panel，P0）。
//
// 职责：把 core 的 a2a-tool-source 接到 chrome 平台上 ——
// - 每远程 agent 的 bearer token 存 chrome.storage.local（键 a2aTokens，不入 profile，
//   对齐「apiKey 不允许覆写」的安全立场，设计 §5 D5）；
// - 随激活智能体的 a2aAgents 变化同步工具源（sync，App watch 驱动）；
// - 设置页「测试连通」直连 client.fetchAgentCard（不落工具清单）。
//
// 边界：领域逻辑（卡片校验/任务编排/结果包装）全部在 webmcp-agent-chat-core，
// 本模块只做 token 存取 + 配置解析 + 生命周期托管（C8：宿主只调用，不实现领域逻辑）。
import {
  createA2aClient,
  createA2aToolSource,
  validateA2aAgentId,
  type A2aAgentConfig,
  type A2aToolResult,
  type A2aToolSource,
  type AgentA2aRef,
  type AgentCard,
} from 'webmcp-agent-chat-core';
import type { LlmLogFn } from 'webmcp-agent-chat-core';

/** token 持久化的存储最小结构面（便于测试注入桩，同 ProfileStorageLike 形状）。 */
export interface A2aStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** chrome.storage.local 中的 token 持久化键（agentId → bearer token）。 */
export const A2A_TOKENS_STORAGE_KEY = 'a2aTokens';

function defaultStorage(): A2aStorageLike {
  return chrome.storage.local as unknown as A2aStorageLike;
}

/** 读取全部 token 映射（存储数据不可信：仅保留 string→string 条目）。 */
export async function loadA2aTokens(storage: A2aStorageLike = defaultStorage()): Promise<Record<string, string>> {
  const stored = await storage.get([A2A_TOKENS_STORAGE_KEY]);
  const value = stored[A2A_TOKENS_STORAGE_KEY];
  if (typeof value !== 'object' || value === null) return {};
  const tokens: Record<string, string> = {};
  for (const [key, token] of Object.entries(value as Record<string, unknown>)) {
    if (typeof token === 'string' && key.length > 0) tokens[key] = token;
  }
  return tokens;
}

/** 持久化全部 token 映射（整体覆盖写；调用方经 App 的 saveToken 收口单条更新）。 */
export async function saveA2aTokens(
  tokens: Record<string, string>,
  storage: A2aStorageLike = defaultStorage()
): Promise<void> {
  await storage.set({ [A2A_TOKENS_STORAGE_KEY]: tokens });
}

export interface A2aToolHostDeps {
  /** fetch 实现（默认全局 fetch，测试注入桩）。 */
  fetchImpl?: typeof fetch;
  /** token 存储（默认 chrome.storage.local）。 */
  storage?: A2aStorageLike;
  /** 日志钩子（透传给 core 工具源；payload 不含 token）。 */
  onLog?: LlmLogFn;
  /** 阻塞 send 超时毫秒（透传 core，测试可缩短）。 */
  sendTimeoutMs?: number;
}

export interface A2aToolHost {
  /**
   * 按激活智能体同步工具源：enabled 的 a2aAgents + token 组装配置 → 预取卡片重建清单。
   * activeAgent 为 null（无智能体）时清空清单。异步执行不抛错（失败经日志 + 失败列表记录）。
   * 返回卡片抓取/配置校验失败的 agentKey 列表（App 据此做 UI 提示）。
   */
  sync(activeAgent: { a2aAgents: AgentA2aRef[] } | null): Promise<string[]>;
  /** 当前可用工具清单（透传 core）。 */
  listTools(): ReturnType<A2aToolSource['listTools']>;
  /** 是否为 a2a__ 命名空间工具（App callTool 路由判定）。 */
  handles(name: string): boolean;
  /** 执行 a2a__ 工具（统一返回 MCP CallToolResult 形状；非 a2a 名抛错）。 */
  callTool(name: string, args: Record<string, unknown>): Promise<A2aToolResult>;
  /** 设置页连通测试：抓取并校验卡片，返回人类可读结果文案（不进工具清单）。 */
  testConnection(cardUrl: string, token?: string): Promise<string>;
}

export function createA2aToolHost(deps: A2aToolHostDeps = {}): A2aToolHost {
  const storage = deps.storage ?? defaultStorage();
  const onLog: LlmLogFn = deps.onLog ?? (() => {});
  const client = createA2aClient({ fetchImpl: deps.fetchImpl ?? fetch, onLog });
  const source = createA2aToolSource({
    client,
    onLog,
    ...(deps.sendTimeoutMs !== undefined ? { sendTimeoutMs: deps.sendTimeoutMs } : {}),
  });

  return {
    async sync(activeAgent) {
      const refs = activeAgent?.a2aAgents ?? [];
      const tokens = await loadA2aTokens(storage);
      const configs: A2aAgentConfig[] = [];
      const invalid: string[] = [];
      for (const ref of refs) {
        if (!ref.enabled) continue;
        try {
          validateA2aAgentId(ref.id);
          configs.push({
            id: ref.id,
            cardUrl: ref.cardUrl,
            ...(tokens[ref.id] !== undefined ? { token: tokens[ref.id] } : {}),
            ...(ref.endpointOverride !== undefined && ref.endpointOverride.trim().length > 0
              ? { endpointOverride: ref.endpointOverride.trim() }
              : {}),
          });
        } catch {
          invalid.push(ref.id);
        }
      }
      if (invalid.length > 0) {
        onLog('warn', 'a2a_invalid_agent_ids', { agentIds: invalid });
      }
      const failures = await source.setAgents(configs);
      if (failures.length > 0) {
        onLog('warn', 'a2a_sync_failures', { agentIds: failures });
      }
      onLog('info', 'a2a_synced', { total: configs.length, failed: failures.length });
      return failures;
    },

    listTools() {
      return source.listTools();
    },

    handles(name) {
      return name.startsWith('a2a__') && name.endsWith('__send_task');
    },

    async callTool(name, args) {
      return source.callTool(name, args);
    },

    async testConnection(cardUrl, token) {
      try {
        const card: AgentCard = await client.fetchAgentCard(cardUrl, token !== undefined ? { token } : {});
        return `连通：${card.name}（v${card.version}，技能 ${card.skills.length} 项，端点 ${card.supportedInterfaces[0]?.url ?? '无'}）`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `连通失败：${message}`;
      }
    },
  };
}
