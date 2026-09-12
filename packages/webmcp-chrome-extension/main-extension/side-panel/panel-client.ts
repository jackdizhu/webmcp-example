// 侧边栏侧的页面工具客户端（2026-09-12 全局页签选择改造）。
//
// 连接目标 = 全局选中页签集合（单一事实源在 SW tab-source-manager，经 relay-status
// 端口同步给 App，App 调 setTargetTabs 下发）。每个选中页签一条 chrome.tabs.connect
// 长连接；**不再监听 tabs.onActivated 自动跟随**（R2/R3 决策：默认只连打开侧栏时的
// 第一个活动页签，改连需手动切换）。
//
// 多选全端生效（Q2 决策）：
// - listTools 合并全部选中页签的工具清单；页面工具**统一**加 `tab<id>__` 前缀命名空间
//   （2026-09-13 决策：单页签/多页签一致，不再只对同名冲突去歧义 —— 暴露名 → 页签路由表）；
// - callTool 经路由表投递到对应页签的 Port；
// - 断线重连按页签独立进行（指数退避 1s→15s），重连目标 = 各自 tabId（不重查活动页签）。
import {
  PAGE_TOOLS_PORT_NAME,
  type PageToolMeta,
  type PageToolsRequest,
  type PageToolsResponse,
} from '../../core/page-tools-bridge';
import {
  executeBuiltinTool,
  isBuiltinTool,
  mergeBuiltinWithPageTools,
  type BuiltinToolContext,
} from '../../core/builtin-tools';
import { DEFAULT_SYSTEM_PROMPT } from 'webmcp-agent-chat-core';

export interface PageToolsClient {
  /** 获取全部选中页签暴露的工具清单（合并 + 统一 tab<id>__ 前缀命名空间，见模块头注释）。 */
  listTools(): Promise<PageToolMeta[]>;
  /** 调用某个工具（按路由表投递到对应页签）。 */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 更新连接目标页签集合（全局选中页签；新增页签建连、移除页签断开）。 */
  setTargetTabs(tabIds: number[]): void;
  /** 聚合连接状态变化回调（全部目标在线 = true；无目标或任一离线 = false）。 */
  onStatusChange(listener: (connected: boolean) => void): () => void;
  /** 任一页签工具清单变化（桥接 toolsChanged 推送）回调。 */
  onToolsChange(listener: () => void): () => void;
  /** 主动断开（侧边栏卸载时调用）。 */
  disconnect(): void;
}

/**
 * 给页面工具客户端叠加内置工具（chrome_extension_*，双端统一注册表的侧栏入口）：
 * - listTools 合并内置描述（内置在前；页面工具占用内置命名空间时剔除，内置优先）；
 * - callTool 内置名优先路由到扩展上下文执行（executeBuiltinTool），其余透传页面工具。
 *   内置工具与页面工具统一返回 MCP CallToolResult 形态（`{content, isError}`），
 *   调用方（agent 循环 / 调试页）无需分支处理两种形状。
 *
 * 连接语义完全委托入参客户端（setTargetTabs / 状态与清单订阅 / disconnect），
 * 因此 agent 对话与 tools 调试页可共用同一份实例 —— 避免两处各自拦截导致行为漂移。
 */
export function attachBuiltinTools(
  pageTools: PageToolsClient,
  context: BuiltinToolContext
): PageToolsClient {
  return {
    async listTools() {
      return mergeBuiltinWithPageTools(await pageTools.listTools());
    },
    callTool(name, args) {
      return isBuiltinTool(name)
        ? executeBuiltinTool(name, args, context)
        : pageTools.callTool(name, args);
    },
    setTargetTabs(tabIds) {
      pageTools.setTargetTabs(tabIds);
    },
    onStatusChange(listener) {
      return pageTools.onStatusChange(listener);
    },
    onToolsChange(listener) {
      return pageTools.onToolsChange(listener);
    },
    disconnect() {
      pageTools.disconnect();
    },
  };
}

/**
 * 给页面工具客户端再叠加「注入工具」层（a2a__* / __agent_load_skill 等 App 缝注入的工具）：
 * - listTools 结果前置注入清单（动态求值，随激活智能体/skills 配置变化）；
 * - callTool 注入名优先路由到宿主缝执行（返回 MCP CallToolResult 形状），其余透传底层客户端。
 *
 * 动机：此前 a2a/skill 工具只注入在 agent 对话缝（chat-controller getTools/callTool），
 * tools 调试页经同一 pageTools 实例看不到也调不到。统一收到注入层后，调试页与
 * agent 循环共用同一份清单与执行路径（对齐「一处合成，多处消费」的既有分层决策）。
 */
export function attachInjectedTools(
  pageTools: PageToolsClient,
  deps: {
    /** 动态注入工具清单（每次 listTools 调用时求值，置于页面/内置工具之前）。 */
    listInjected: () => PageToolMeta[];
    /** 是否为注入命名空间（callTool 路由判定）。 */
    handles: (name: string) => boolean;
    /** 执行注入工具（返回 MCP CallToolResult 同构形状）。 */
    callInjected: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  }
): PageToolsClient {
  return {
    async listTools() {
      return [...deps.listInjected(), ...(await pageTools.listTools())];
    },
    callTool(name, args) {
      return deps.handles(name) ? deps.callInjected(name, args) : pageTools.callTool(name, args);
    },
    setTargetTabs(tabIds) {
      pageTools.setTargetTabs(tabIds);
    },
    onStatusChange(listener) {
      return pageTools.onStatusChange(listener);
    },
    onToolsChange(listener) {
      return pageTools.onToolsChange(listener);
    },
    disconnect() {
      pageTools.disconnect();
    },
  };
}

/** 侧边栏设置（持久化到 chrome.storage.local）。 */export interface PanelSettings {
  apiKey: string;
  baseUrl: string;
  /** chat completions 请求路径；空串 = 用户显式清空（不回退默认，发请求前会提示配置）。 */
  apiPath: string;
  model: string;
  /**
   * LLM API 协议类型（R4 决策：仅支持 openai-compat 与 anthropic 两个适配器）。
   * 缺省 openai-compat 兼容存量配置。
   */
  apiProtocol: 'openai-compat' | 'anthropic';
  /** Anthropic Messages API 必填的 max_tokens（openai-compat 协议不消费）。 */
  maxTokens: number;
  /** 调试模式：开启后侧栏出现「调试」Tab（手动执行工具，不经 LLM）。 */
  debugMode: boolean;
  /** 控制台输出：开启后日志同步打印到控制台（带 traceId 前缀）；默认关，仅写 IndexedDB。 */
  consoleOutput: boolean;
  /** agent 系统提示词；为空串时使用内置默认的页面工具验证助手提示词。 */
  systemPrompt: string;
  /** 每轮发送给 LLM 的历史对话轮数上限（0 = 不裁剪）；默认 5。 */
  maxHistoryTurns: number;
}

export const DEFAULT_SETTINGS: PanelSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  apiPath: '/chat/completions',
  model: 'deepseek-v4-flash',
  apiProtocol: 'openai-compat',
  maxTokens: 4096,
  debugMode: false,
  consoleOutput: false,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxHistoryTurns: 5,
};

const SETTINGS_KEYS = [
  'llmApiKey',
  'llmBaseUrl',
  'llmApiPath',
  'llmModel',
  'llmApiProtocol',
  'llmMaxTokens',
  'debugMode',
  'consoleOutput',
  'llmSystemPrompt',
  'agentMaxHistoryTurns',
] as const;

/**
 * 读取并消费 chrome.runtime.lastError。
 *
 * Chrome 约定：connect 找不到接收端时会把错误写入 lastError，若 onDisconnect
 * 监听器未读取它，控制台会打印 "Unchecked runtime.lastError: Could not
 * establish connection. Receiving end does not exist." 告警。经 globalThis
 * 取值以兼容测试环境（无 chrome 全局），属性访问本身即完成"消费"。
 */
function consumeRuntimeLastError(): string | undefined {
  const chromeGlobal = (globalThis as {
    chrome?: { runtime?: { lastError?: { message?: string } } };
  }).chrome;
  return chromeGlobal?.runtime?.lastError?.message;
}

/** 断线重连：首次退避间隔与上限（指数退避，按页签独立）。 */
const RECONNECT_DELAY_INITIAL_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 15_000;
/** 重连探活 ping 的超时（远短于业务请求）。 */
const RECONNECT_PING_TIMEOUT_MS = 5_000;

/**
 * 默认连接工厂：建立到指定页签 content script 桥接的长连接。
 * 目标标签页上没有桥接时不会同步报错——Port 会在异步 onDisconnect 中失败，由重连逻辑兜底。
 */
async function defaultPortFactory(tabId: number): Promise<chrome.runtime.Port> {
  return chrome.tabs.connect(tabId, { name: PAGE_TOOLS_PORT_NAME });
}

/** 从 chrome.storage.local 读取设置，缺省项回退默认值。 */
export async function loadSettings(storage: {
  get: typeof chrome.storage.local.get;
} = chrome.storage.local): Promise<PanelSettings> {
  const stored = await storage.get([...SETTINGS_KEYS]);
  return {
    apiKey: typeof stored['llmApiKey'] === 'string' ? stored['llmApiKey'] : DEFAULT_SETTINGS.apiKey,
    baseUrl: typeof stored['llmBaseUrl'] === 'string' ? stored['llmBaseUrl'] : DEFAULT_SETTINGS.baseUrl,
    // 空串是"显式清空"的合法值，必须保留：仅缺省（非字符串）时才回退默认路径
    apiPath: typeof stored['llmApiPath'] === 'string' ? stored['llmApiPath'] : DEFAULT_SETTINGS.apiPath,
    model: typeof stored['llmModel'] === 'string' ? stored['llmModel'] : DEFAULT_SETTINGS.model,
    apiProtocol:
      stored['llmApiProtocol'] === 'anthropic' ? 'anthropic' : DEFAULT_SETTINGS.apiProtocol,
    maxTokens:
      typeof stored['llmMaxTokens'] === 'number' && Number.isInteger(stored['llmMaxTokens']) && stored['llmMaxTokens'] > 0
        ? stored['llmMaxTokens']
        : DEFAULT_SETTINGS.maxTokens,
    debugMode: stored['debugMode'] === true,
    consoleOutput: stored['consoleOutput'] === true,
    systemPrompt:
      typeof stored['llmSystemPrompt'] === 'string' ? stored['llmSystemPrompt'] : DEFAULT_SETTINGS.systemPrompt,
    maxHistoryTurns:
      typeof stored['agentMaxHistoryTurns'] === 'number' && Number.isInteger(stored['agentMaxHistoryTurns'])
        ? stored['agentMaxHistoryTurns']
        : DEFAULT_SETTINGS.maxHistoryTurns,
  };
}

/** 保存设置到 chrome.storage.local。 */
export async function saveSettings(
  settings: PanelSettings,
  storage: { set: typeof chrome.storage.local.set } = chrome.storage.local
): Promise<void> {
  await storage.set({
    llmApiKey: settings.apiKey,
    llmBaseUrl: settings.baseUrl,
    llmApiPath: settings.apiPath,
    llmModel: settings.model,
    llmApiProtocol: settings.apiProtocol,
    llmMaxTokens: settings.maxTokens,
    debugMode: settings.debugMode,
    consoleOutput: settings.consoleOutput,
    llmSystemPrompt: settings.systemPrompt,
    agentMaxHistoryTurns: settings.maxHistoryTurns,
  });
}

/**
 * settings → 待持久化快照（纯浅拷贝，逐字段显式列出）。
 *
 * 动机：App 的 settings 是 Vue reactive 代理，saveSettings 前收敛为普通对象，
 * 避免调用处手写字段列表（新增字段只改这一处）。与 loadSettings/saveSettings
 * 同居此处，持久化协议三件套对称收口。
 */
export function toPanelSettings(settings: PanelSettings): PanelSettings {
  return {
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    apiPath: settings.apiPath,
    model: settings.model,
    apiProtocol: settings.apiProtocol,
    maxTokens: settings.maxTokens,
    debugMode: settings.debugMode,
    consoleOutput: settings.consoleOutput,
    systemPrompt: settings.systemPrompt,
    maxHistoryTurns: settings.maxHistoryTurns,
  };
}

/** 单个页签的连接状态（一条 Port + 独立重连循环 + 独立请求表）。 */
interface TabConnection {
  tabId: number;
  port: chrome.runtime.Port | undefined;
  /** 进行中的端口创建（异步工厂去重）。 */
  portCreation: Promise<chrome.runtime.Port> | null;
  connected: boolean;
  /** 已从目标集合移除（终止重连循环，连接对象即将丢弃）。 */
  removed: boolean;
  reconnectDelayMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<number, { resolve: (value: PageToolsResponse) => void; reject: (error: Error) => void }>;
  nextId: number;
  /** 最近一次成功拉取的工具清单（路由表与合并清单的数据源）。 */
  lastTools: PageToolMeta[] | null;
}

/**
 * 建立页面工具客户端（多页签编排版）。
 *
 * 连接目标：经 setTargetTabs 下发的全局选中页签集合。目标为空时离线；
 * 聚合在线判定 = 全部目标页签均收到过首条响应（避免 Port 建立即乐观置位）。
 *
 * @param portFactory 创建 Port 的工厂（入参为页签 id，测试可注入桩）
 * @param requestTimeoutMs 单请求超时（毫秒），默认 30s（工具执行可能较慢）
 */
export function connectPageTools(
  portFactory: (tabId: number) => chrome.runtime.Port | Promise<chrome.runtime.Port> = defaultPortFactory,
  requestTimeoutMs = 30_000
): PageToolsClient {
  const connections = new Map<number, TabConnection>();
  /** 暴露名 → 路由目标（页面工具统一 tab<id>__ 前缀命名空间）。 */
  const routes = new Map<string, { conn: TabConnection; originalName: string }>();
  let disposed = false;
  let lastEmittedConnected: boolean | null = null;
  const statusListeners = new Set<(connected: boolean) => void>();
  const toolsListeners = new Set<() => void>();

  // ---- 聚合状态 ----

  const computeConnected = (): boolean => {
    const all = [...connections.values()];
    return all.length > 0 && all.every((conn) => conn.connected);
  };

  const emitStatus = (): void => {
    const connected = computeConnected();
    if (connected === lastEmittedConnected) return;
    lastEmittedConnected = connected;
    for (const listener of statusListeners) listener(connected);
  };

  const setConnConnected = (conn: TabConnection, value: boolean): void => {
    if (conn.connected === value) return;
    conn.connected = value;
    emitStatus();
  };

  const notifyToolsChange = (): void => {
    for (const listener of toolsListeners) listener();
  };

  // ---- 单页签连接 ----

  const clearReconnectTimer = (conn: TabConnection): void => {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
  };

  const scheduleReconnect = (conn: TabConnection): void => {
    if (disposed || conn.removed || conn.connected || conn.reconnectTimer) return;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      if (disposed || conn.removed || conn.connected) return;
      void verifyConnection(conn);
    }, conn.reconnectDelayMs);
    conn.reconnectDelayMs = Math.min(conn.reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
  };

  /** 重连探活：ping 一次 listTools，成功即恢复在线并重置退避。 */
  const verifyConnection = async (conn: TabConnection): Promise<void> => {
    if (disposed || conn.removed || conn.connected) return;
    try {
      await request(conn, { type: 'listTools' }, RECONNECT_PING_TIMEOUT_MS);
      // 成功路径无需处理：首条响应到达时 onMessage 已置在线并重置退避
    } catch {
      // 超时（Port 仍在）时主动断开以触发统一的 onDisconnect 清理；
      // 已断开（接收端不存在）场景 onDisconnect 内部已排定下一次尝试（幂等）
      conn.port?.disconnect();
      conn.port = undefined;
      if (conn.connected) return; // 竞态兜底：响应恰好在超时后到达
      setConnConnected(conn, false);
      scheduleReconnect(conn);
    }
  };

  const attachPort = (conn: TabConnection, fresh: chrome.runtime.Port): chrome.runtime.Port => {
    fresh.onMessage.addListener((message: unknown) => {
      // 桥接单向通知：页面工具清单变化（无 id，区别于请求响应）
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown })['type'] === 'toolsChanged'
      ) {
        // 缓存清单已过期：置空待下次 listTools 刷新（路由表随刷新重建）
        conn.lastTools = null;
        notifyToolsChange();
        return;
      }
      const response = message as PageToolsResponse;
      const waiter = conn.pending.get(response.id);
      if (!waiter) return;
      conn.pending.delete(response.id);
      // 收到首条响应才算真正在线：避免 Port 建立即乐观置位造成的在线/离线抖动
      if (!conn.connected) {
        conn.reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
        setConnConnected(conn, true);
      }
      waiter.resolve(response);
    });
    fresh.onDisconnect.addListener(() => {
      // 必须读取 lastError，否则 Chrome 打印 Unchecked runtime.lastError 告警
      consumeRuntimeLastError();
      teardownConn(conn);
      // 主动重连：content script 就绪晚于侧栏（或页面跳转后）也能自动恢复；
      // 重连目标保持该页签自身 tabId（R2/R3：不随活动页签漂移）
      scheduleReconnect(conn);
    });
    conn.port = fresh;
    return fresh;
  };

  /** 统一的断开清理：清空端口引用、拒绝挂起请求、置离线。 */
  const teardownConn = (conn: TabConnection): void => {
    conn.port = undefined;
    for (const [, waiter] of conn.pending) waiter.reject(new Error('页面工具桥接连接已断开'));
    conn.pending.clear();
    setConnConnected(conn, false);
  };

  /** 获取（或异步创建）页签端口；工厂为异步时用 portCreation 去重并发创建。 */
  const ensurePort = (conn: TabConnection): Promise<chrome.runtime.Port> => {
    if (conn.port) return Promise.resolve(conn.port);
    if (!conn.portCreation) {
      conn.portCreation = Promise.resolve(portFactory(conn.tabId))
        .then((fresh) => {
          conn.portCreation = null;
          if (disposed || conn.removed) {
            fresh.disconnect();
            throw new Error('页面工具客户端已释放');
          }
          return attachPort(conn, fresh);
        })
        .catch((error: unknown) => {
          conn.portCreation = null;
          throw error instanceof Error ? error : new Error(String(error));
        });
    }
    return conn.portCreation;
  };

  const request = async (
    conn: TabConnection,
    req: Omit<PageToolsRequest, 'id'>,
    timeoutMs: number = requestTimeoutMs
  ): Promise<PageToolsResponse> => {
    const fresh = await ensurePort(conn);
    const id = conn.nextId;
    conn.nextId += 1;
    return new Promise<PageToolsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`页面工具请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      conn.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        fresh.postMessage({ ...req, id } satisfies PageToolsRequest);
      } catch (error) {
        conn.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const createConnection = (tabId: number): TabConnection => {
    const conn: TabConnection = {
      tabId,
      port: undefined,
      portCreation: null,
      connected: false,
      removed: false,
      reconnectDelayMs: RECONNECT_DELAY_INITIAL_MS,
      reconnectTimer: null,
      pending: new Map(),
      nextId: 1,
      lastTools: null,
    };
    connections.set(tabId, conn);
    // 目标加入即建连（而非懒建连）：让聚合状态尽快反映页签可达性；
    // 失败（如接收端不存在）走统一退避重连
    void ensurePort(conn).catch(() => {
      if (!disposed && !conn.removed) {
        setConnConnected(conn, false);
        scheduleReconnect(conn);
      }
    });
    return conn;
  };

  /** 彻底移除一个页签连接（目标集合变更 / 客户端释放）。 */
  const disposeConnection = (conn: TabConnection): void => {
    conn.removed = true;
    clearReconnectTimer(conn);
    conn.port?.disconnect();
    conn.port = undefined;
    conn.portCreation = null;
    for (const [, waiter] of conn.pending) waiter.reject(new Error('页面工具客户端已释放'));
    conn.pending.clear();
    connections.delete(conn.tabId);
  };

  // ---- 工具清单合并与路由 ----

  /** 页签工具的统一暴露名：`tab<id>__` 前缀命名空间（单/多页签一致，`<id>` 为数据源页签 tabId）。 */
  const exposedName = (conn: TabConnection, toolName: string): string =>
    `tab${conn.tabId}__${toolName}`;

  /** 依据各页签缓存清单重建路由表：页面工具统一加 tab<id>__ 前缀（单/多页签一致）。 */
  const rebuildRoutes = (): void => {
    routes.clear();
    for (const conn of connections.values()) {
      for (const tool of conn.lastTools ?? []) {
        routes.set(exposedName(conn, tool.name), { conn, originalName: tool.name });
      }
    }
  };

  const listToolsForConn = async (conn: TabConnection): Promise<PageToolMeta[]> => {
    const response = await request(conn, { type: 'listTools' });
    if (!response.ok) throw new Error(response.error ?? 'listTools 失败');
    const tools = response.result as PageToolMeta[];
    conn.lastTools = tools;
    return tools;
  };

  // ---- 对外 API ----

  return {
    setTargetTabs(tabIds: number[]) {
      if (disposed) return;
      const next = new Set(tabIds);
      for (const conn of [...connections.values()]) {
        if (!next.has(conn.tabId)) disposeConnection(conn);
      }
      for (const tabId of next) {
        if (!connections.has(tabId)) createConnection(tabId);
      }
      rebuildRoutes();
      emitStatus();
    },

    async listTools() {
      const all = [...connections.values()];
      if (all.length === 0) return [];
      const settled = await Promise.allSettled(all.map((conn) => listToolsForConn(conn)));
      rebuildRoutes();
      const firstFailure = settled.find(
        (item): item is PromiseRejectedResult => item.status === 'rejected'
      );
      // 全部目标都拉取失败才抛错（部分离线页签不阻断其余页签的工具可用性）
      if (firstFailure && settled.every((item) => item.status === 'rejected')) {
        const reason = firstFailure.reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
      const merged: PageToolMeta[] = [];
      for (const conn of all) {
        for (const tool of conn.lastTools ?? []) {
          merged.push({ ...tool, name: exposedName(conn, tool.name) });
        }
      }
      return merged;
    },

    async callTool(name, args) {
      const route = routes.get(name);
      if (!route) {
        throw new Error(`未知工具或目标页签已移除：${name}`);
      }
      const response = await request(route.conn, { type: 'callTool', name: route.originalName, args });
      if (!response.ok) throw new Error(response.error ?? `调用工具 ${name} 失败`);
      return response.result;
    },

    onStatusChange(listener) {
      statusListeners.add(listener);
      listener(lastEmittedConnected ?? computeConnected());
      return () => statusListeners.delete(listener);
    },

    onToolsChange(listener) {
      toolsListeners.add(listener);
      return () => toolsListeners.delete(listener);
    },

    disconnect() {
      disposed = true;
      for (const conn of [...connections.values()]) {
        disposeConnection(conn);
      }
      routes.clear();
      lastEmittedConnected = null;
      statusListeners.clear();
      toolsListeners.clear();
    },
  };
}
