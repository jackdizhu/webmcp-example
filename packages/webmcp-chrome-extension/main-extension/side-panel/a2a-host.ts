// A2A 宿主托管模块（side-panel，P0；2026-09-16 协议配置扩展）。
//
// 职责：把 core 的 a2a-tool-source 接到 chrome 平台上 ——
// - 每远程 agent 的凭据（jsonrpc bearer token / dify api-key）存 chrome.storage.local
//   （键 a2aTokens，不入配置，对齐「apiKey 不允许覆写」的安全立场，设计 §5 D5）；
// - Dify 终端用户标识：每安装稳定 uuid（键 difyUserId，首次生成后持久化；
//   Dify 契约 user 必填，固定标识保证会话归属与统计连续）；
// - 随全局 A2A 配置（a2aConfig，2026-09-14 与智能体解耦）变化同步工具源（sync，App watch 驱动）；
// - 设置页「测试连通」按协议分派：jsonrpc 直连 fetchAgentCard；dify 发送最小真实 query
//   探测（用户决策：接受真实调用副作用，可验证 endpoint 与 api-key）。
//
// 边界：领域逻辑（卡片校验/任务编排/结果包装）全部在 webmcp-agent-chat-core，
// 本模块只做凭据存取 + 配置解析 + 生命周期托管（C8：宿主只调用，不实现领域逻辑）。
import {
  a2aRefProtocol,
  createA2aClient,
  createA2aToolSource,
  createDifyClient,
  validateA2aAgentId,
  type A2aAgentConfig,
  type A2aToolResult,
  type A2aToolSource,
  type AgentA2aRef,
  type AgentCard,
  type DifyClient,
} from 'webmcp-agent-chat-core';
import type { LlmLogFn } from 'webmcp-agent-chat-core';

/** token 持久化的存储最小结构面（便于测试注入桩，同 ProfileStorageLike 形状）。 */
export interface A2aStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** chrome.storage.local 中的凭据持久化键（agentId → bearer token / Dify api-key）。 */
export const A2A_TOKENS_STORAGE_KEY = 'a2aTokens';
/** Dify 终端用户标识持久化键（每安装稳定 uuid，首次调用生成后落盘）。 */
export const DIFY_USER_ID_STORAGE_KEY = 'difyUserId';

function defaultStorage(): A2aStorageLike {
  return chrome.storage.local as unknown as A2aStorageLike;
}

/** 读取全部凭据映射（存储数据不可信：仅保留 string→string 条目）。 */
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

/** 持久化全部凭据映射（整体覆盖写；调用方经 App 的 saveToken 收口单条更新）。 */
export async function saveA2aTokens(
  tokens: Record<string, string>,
  storage: A2aStorageLike = defaultStorage()
): Promise<void> {
  await storage.set({ [A2A_TOKENS_STORAGE_KEY]: tokens });
}

/**
 * 读取（或首次生成并持久化）Dify 终端用户标识：每安装稳定 uuid。
 * crypto.randomUUID 不可用时降级为时间戳 + 随机段（仅保证唯一性，不影响功能）。
 */
export async function ensureDifyUserId(storage: A2aStorageLike = defaultStorage()): Promise<string> {
  const stored = await storage.get([DIFY_USER_ID_STORAGE_KEY]);
  const value = stored[DIFY_USER_ID_STORAGE_KEY];
  if (typeof value === 'string' && value.length > 0) return value;
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `webmcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await storage.set({ [DIFY_USER_ID_STORAGE_KEY]: generated });
  return generated;
}

export interface A2aToolHostDeps {
  /** fetch 实现（默认全局 fetch，测试注入桩）。 */
  fetchImpl?: typeof fetch;
  /** 凭据存储（默认 chrome.storage.local）。 */
  storage?: A2aStorageLike;
  /** 日志钩子（透传给 core 工具源；payload 不含凭据）。 */
  onLog?: LlmLogFn;
  /** 阻塞 send 超时毫秒（透传 core，测试可缩短）。 */
  sendTimeoutMs?: number;
}

export interface A2aToolHost {
  /**
   * 按全局 A2A 配置同步工具源：enabled 的 refs + 凭据按协议组装 →
   * jsonrpc 预取卡片重建清单 / dify 静态构建。refs 为 null/空时清空清单。
   * 异步执行不抛错（失败经日志 + 失败列表记录）。
   * 返回卡片抓取/配置校验失败的 agentKey 列表（App 据此做 UI 提示）。
   */
  sync(refs: AgentA2aRef[] | null): Promise<string[]>;
  /** 当前可用工具清单（透传 core）。 */
  listTools(): ReturnType<A2aToolSource['listTools']>;
  /** 是否为本工具源命名空间工具（a2a__ / a2a_dify__ 前缀，App callTool 路由判定）。 */
  handles(name: string): boolean;
  /** 执行本工具源工具（统一返回 MCP CallToolResult 形状；非本命名空间抛错）。 */
  callTool(name: string, args: Record<string, unknown>): Promise<A2aToolResult>;
  /** 设置页连通测试（按协议分派，不进工具清单；dify 为真实调用探测）。 */
  testConnection(ref: AgentA2aRef, token?: string): Promise<string>;
}

export function createA2aToolHost(deps: A2aToolHostDeps = {}): A2aToolHost {
  const storage = deps.storage ?? defaultStorage();
  const onLog: LlmLogFn = deps.onLog ?? (() => {});
  const fetchImpl = deps.fetchImpl ?? fetch;
  const client = createA2aClient({ fetchImpl, onLog });
  const dify: DifyClient = createDifyClient({ fetchImpl, onLog });
  const source = createA2aToolSource({
    client,
    difyClient: dify,
    onLog,
    ...(deps.sendTimeoutMs !== undefined ? { sendTimeoutMs: deps.sendTimeoutMs } : {}),
  });

  return {
    async sync(refs) {
      const list = refs ?? [];
      const tokens = await loadA2aTokens(storage);
      const difyUser = await ensureDifyUserId(storage);
      const configs: A2aAgentConfig[] = [];
      const invalid: string[] = [];
      for (const ref of list) {
        if (!ref.enabled) continue;
        try {
          validateA2aAgentId(ref.id);
          if (a2aRefProtocol(ref) === 'dify') {
            configs.push({
              id: ref.id,
              protocol: 'dify',
              ...(tokens[ref.id] !== undefined ? { token: tokens[ref.id] } : {}),
              ...(ref.endpoint !== undefined && ref.endpoint.trim().length > 0
                ? { endpoint: ref.endpoint.trim() }
                : {}),
              ...(ref.responseMode !== undefined ? { responseMode: ref.responseMode } : {}),
              ...(ref.displayName !== undefined ? { displayName: ref.displayName } : {}),
              ...(ref.description !== undefined ? { description: ref.description } : {}),
              ...(ref.inputs !== undefined ? { inputs: ref.inputs } : {}),
              user: difyUser,
            });
            continue;
          }
          // jsonrpc 条目：cardUrl 必填（防御式；正常由存储校验拦截）
          if (ref.cardUrl === undefined || ref.cardUrl.trim().length === 0) {
            invalid.push(ref.id);
            continue;
          }
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
      return (
        (name.startsWith('a2a__') || name.startsWith('a2a_dify__')) && name.endsWith('__send_task')
      );
    },

    async callTool(name, args) {
      return source.callTool(name, args);
    },

    async testConnection(ref, token) {
      if (a2aRefProtocol(ref) === 'dify') {
        try {
          const result = await dify.chat(
            {
              endpoint: ref.endpoint ?? '',
              query: 'ping',
              responseMode: ref.responseMode ?? 'streaming',
              user: await ensureDifyUserId(storage),
              inputs: ref.inputs ?? {},
            },
            { ...(token !== undefined && token.length > 0 ? { token } : {}) }
          );
          const preview = result.answer.length > 0 ? result.answer.slice(0, 50) : '（空回复）';
          return `连通：回复「${preview}」${
            result.conversationId !== undefined ? `（conversationId: ${result.conversationId}）` : ''
          }`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `连通失败：${message}`;
        }
      }
      try {
        const card: AgentCard = await client.fetchAgentCard(
          ref.cardUrl ?? '',
          token !== undefined ? { token } : {}
        );
        return `连通：${card.name}（v${card.version}，技能 ${card.skills.length} 项，端点 ${card.supportedInterfaces[0]?.url ?? '无'}）`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `连通失败：${message}`;
      }
    },
  };
}
