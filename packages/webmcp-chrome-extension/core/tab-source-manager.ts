// SW 侧标签页源编排：把「页面工具（page-tools 桥接协议）」与「relay 浏览器源客户端」
// 按 tabId 一一对接。每个 http(s) 标签页建立一条到本机 relay 的 WebSocket，
// 保留 relay 的 source 模型（webmcp_list_sources 逐 tab 展示、同名工具跨 tab 去歧义）。
//
// 通道复用说明：SW → content script 使用 chrome.tabs.connect(tabId)（官方文档明确
// runtime.connect 到不了 content script）；port name 与协议消息复用 page-tools-bridge
// 的既有定义，content script 端 onConnect 本就接受任意扩展上下文的 Port，零改动。
import {
  PAGE_TOOLS_PORT_NAME,
  type PageToolMeta,
  type PageToolsRequest,
  type PageToolsResponse,
} from './page-tools-bridge';
import {
  RELAY_STATUS_PORT_NAME,
  type RelayStatusMessage,
  type RelayStatusRequest,
  type RelayTabStatus,
} from './relay-status-protocol';
import {
  RelaySourceClient,
  type RelayConnectionStatus,
  type RelayEndpoint,
  type RelaySourceMeta,
  type RelayToolsFacade,
  type RelayToolDescriptor,
} from './relay-source-client';

/** SW 休眠/重启后重扫已打开页面用的 URL 模式。 */
const RESCAN_URL_PATTERNS = ['http://*/*', 'https://*/*'];

/** 诊断日志前缀：排查「无活动标签页」类问题时在 SW 控制台按此过滤。 */
const DIAG_TAG = '[webmcp-relay-source][diag]';
/** URL 不可见警告只提示一次（每次导航都会触发 ensureClient，避免刷屏）。 */
let warnedUrlInvisible = false;

/** chrome.scripting 最小面（重注入 content scripts 用）。 */
interface ChromeScriptingLike {
  executeScript(details: {
    target: { tabId: number };
    files: string[];
    world?: 'MAIN' | 'ISOLATED';
  }): Promise<unknown>;
}

/** 安全读取 chrome.runtime.lastError（单测 jsdom 环境无 chrome 全局，不能直接访问）。 */
function safeChromeLastError(): { message?: string } | undefined {
  try {
    return chrome.runtime.lastError;
  } catch {
    return undefined;
  }
}

/**
 * 默认自愈注入：经 chrome.scripting 把 content scripts 重注入目标标签页。
 * 需要 manifest 声明 "scripting" 权限与对应 host_permissions（MV3 中
 * content_scripts.matches 不授予 executeScript 权限）。
 */
async function defaultReinjectContentScripts(tabId: number): Promise<void> {
  const scripting = (globalThis as { chrome?: { scripting?: ChromeScriptingLike } }).chrome?.scripting;
  if (!scripting) {
    throw new Error('chrome.scripting unavailable');
  }
  await scripting.executeScript({ target: { tabId }, files: ['main-world.iife.js'], world: 'MAIN' });
  await scripting.executeScript({ target: { tabId }, files: ['content-script.iife.js'] });
}

/**
 * 诊断：tabs API 的 URL 可见性检查。
 * Chrome 行为：无 "tabs" 权限且无匹配 host 权限时，tab.url/title 对扩展不可见
 * （undefined，不报错）；有权限时所有标签页（含 chrome:// 页）都有 url 字段。
 * 因此「全部标签页的 url 都是 undefined」是缺权限的决定性特征。
 */
async function diagnoseUrlVisibility(tabsApi: TabsApi): Promise<void> {
  try {
    const all = await tabsApi.query({});
    if (all.length === 0) {
      console.info(`${DIAG_TAG} 浏览器当前没有任何标签页，rescan 空属正常`);
      return;
    }
    const invisible = all.filter((tab) => typeof tab.url !== 'string');
    if (invisible.length === all.length) {
      console.warn(
        `${DIAG_TAG} 共 ${String(all.length)} 个标签页但全部 URL 不可见（tab.url 为 undefined）——` +
          'MV3 中 content_scripts.matches 不授予 tabs API 的 URL 可见性，' +
          '需要在 manifest 声明 "tabs" 权限（或 http/https host_permissions）后重载扩展。' +
          `样例: ${JSON.stringify(all.slice(0, 3).map((tab) => ({ id: tab.id, url: tab.url ?? null, title: tab.title ?? null })))}`
      );
    } else {
      console.info(
        `${DIAG_TAG} rescan 模式匹配 0 个 http(s) 标签页，但 URL 可见性正常（可见 ${String(all.length - invisible.length)}/${String(all.length)} 个）——浏览器当前确实没有 http(s) 页面`
      );
    }
  } catch (error) {
    console.warn(`${DIAG_TAG} URL 可见性诊断失败:`, error);
  }
}

export interface TabSourceManagerOptions {
  /** relay 主机提示（默认 127.0.0.1）。 */
  hostHint?: string;
  /** relay 优先端口提示（默认 9333）。 */
  portHint?: number;
  /** 端点缓存注入（默认 chrome.storage.local；测试可注入内存实现）。 */
  endpointCache?: {
    read(): Promise<RelayEndpoint | null>;
    write(endpoint: RelayEndpoint): Promise<void>;
    clear(): Promise<void>;
  };
  /** 标签页过滤（默认仅 http/https 页面；入参可能为 undefined，视为不过滤）。 */
  tabFilter?: (url: string | undefined) => boolean;
  /**
   * Port 死亡（页面侧无接收方）后的自愈注入（默认经 chrome.scripting 重注入
   * content scripts；测试可注入桩）。注入失败不阻断重建流程。
   */
  reinjectContentScripts?: (tabId: number) => Promise<void>;
  /** chrome.tabs API 面（默认全局 chrome.tabs；测试注入桩）。 */
  tabsApi?: TabsApi;
  /** 源客户端工厂（默认构造 RelaySourceClient；测试注入记录桩）。 */
  clientFactory?: (input: { tabId: number; source: RelaySourceMeta; facade: RelayToolsFacade }) => ManagedTabSource;
}

/** 编排层管理的源客户端最小面（RelaySourceClient 满足）。 */
export interface ManagedTabSource {
  start(): void;
  stop(): void;
  updateSource(patch: Partial<RelaySourceMeta>): void;
  /** 订阅连接状态变化（RelaySourceClient 原生支持；测试桩需提供）。 */
  onStatus(listener: (status: RelayConnectionStatus) => void): () => void;
}

/** 本模块用到的 chrome.tabs API 最小面。 */
export interface TabsApi {
  get(tabId: number): Promise<{ id?: number; url?: string; title?: string }>;
  query(queryInfo: { url?: string[] }): Promise<Array<{ id?: number; url?: string; title?: string }>>;
  connect(tabId: number, connectInfo?: { name?: string }): chrome.runtime.Port;
  reload(tabId: number): Promise<void>;
  onUpdated: {
    addListener(
      callback: (tabId: number, changeInfo: { status?: string; url?: string }, tab: { id?: number; url?: string; title?: string }) => void
    ): void;
    removeListener(
      callback: (tabId: number, changeInfo: { status?: string; url?: string }, tab: { id?: number; url?: string; title?: string }) => void
    ): void;
  };
  onRemoved: {
    addListener(callback: (tabId: number) => void): void;
    removeListener(callback: (tabId: number) => void): void;
  };
}

function defaultTabsApi(): TabsApi {
  return {
    get: (tabId) => chrome.tabs.get(tabId),
    query: (queryInfo) => chrome.tabs.query(queryInfo),
    connect: (tabId, connectInfo) => chrome.tabs.connect(tabId, connectInfo),
    reload: (tabId) => chrome.tabs.reload(tabId),
    onUpdated: chrome.tabs.onUpdated,
    onRemoved: chrome.tabs.onRemoved,
  };
}

function defaultEndpointCache() {
  return {
    read: async (): Promise<RelayEndpoint | null> => {
      const stored = await chrome.storage.local.get(['relayEndpoint']);
      const value = stored['relayEndpoint'];
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as RelayEndpoint).host === 'string' &&
        typeof (value as RelayEndpoint).port === 'number'
      ) {
        return value as RelayEndpoint;
      }
      return null;
    },
    write: async (endpoint: RelayEndpoint): Promise<void> => {
      await chrome.storage.local.set({ relayEndpoint: endpoint });
    },
    clear: async (): Promise<void> => {
      await chrome.storage.local.remove?.('relayEndpoint');
    },
  };
}

function isHttpUrl(url: string | undefined): boolean {
  return typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'));
}

/** 从 URL 提取 origin（无效 URL 返回 undefined，relay 端 origin 字段可选）。 */
function extractOrigin(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * 基于一个 page-tools 桥接 Port 构建页面工具门面（RelayToolsFacade 实现）。
 * 请求-响应协议与 page-tools-bridge.ts 完全一致，另加调用超时兜底：
 * Port 死亡或 content script 无响应时 reject，由 relay 客户端回 isError result。
 *
 * @param logTag 日志标签（通常为 `tab <id>`），用于在 SW 控制台区分多个标签页的调用。
 */
export function createPortToolsFacade(
  port: chrome.runtime.Port,
  logTag = '<unknown-tab>'
): {
  facade: import('./relay-source-client').RelayToolsFacade;
  disconnect(): void;
} {
  const LOG_PREFIX = `[webmcp-relay-source][${logTag}]`;
  /** 参数/结果摘要：JSON 序列化 + 截断，避免大载荷刷屏。 */
  const summarize = (value: unknown, max = 300): string => {
    try {
      const text = JSON.stringify(value) ?? String(value);
      return text.length > max ? `${text.slice(0, max)}…(+${String(text.length - max)})` : text;
    } catch {
      return '<unserializable>';
    }
  };
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const toolsChangedListeners = new Set<() => void>();

  const INVOKE_TIMEOUT_MS = 60_000;

  const onMessage = (raw: unknown): void => {
    const message = raw as Partial<PageToolsResponse> & { type?: string };
    if (
      typeof message === 'object' &&
      message !== null &&
      message.type === 'toolsChanged'
    ) {
      for (const listener of toolsChangedListeners) {
        listener();
      }
      return;
    }
    if (typeof message?.id !== 'number') {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(message.error ?? 'page-tools bridge error'));
    }
  };
  port.onMessage.addListener(onMessage);

  const rejectAll = (reason: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  };
  port.onDisconnect.addListener(() => rejectAll('page-tools bridge port disconnected'));

  const request = (type: PageToolsRequest['type'], extra?: { name?: string; args?: Record<string, unknown> }): Promise<unknown> => {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`page-tools bridge timeout: ${type}`));
      }, INVOKE_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const payload: PageToolsRequest = { id, type, ...extra };
      try {
        port.postMessage(payload);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const facade: RelayToolsFacade = {
    listTools: async () => {
      const startedAt = Date.now();
      const tools = (await request('listTools')) as PageToolMeta[];
      console.info(
        `${LOG_PREFIX} listTools ← ${String(tools.length)} 个（${String(Date.now() - startedAt)}ms）` +
          (tools.length > 0 ? `: ${tools.map((tool) => tool.name).join(', ')}` : '—— 页面未注册任何 WebMCP 工具')
      );
      return tools.map(
        (tool): RelayToolDescriptor => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })
      );
    },
    callTool: async (name, args) => {
      const startedAt = Date.now();
      console.info(`${LOG_PREFIX} callTool → ${name} args=${summarize(args)}`);
      try {
        const result = await request('callTool', { name, args });
        console.info(
          `${LOG_PREFIX} callTool ← ${name} ok（${String(Date.now() - startedAt)}ms） result=${summarize(result)}`
        );
        return result;
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} callTool ← ${name} FAILED（${String(Date.now() - startedAt)}ms）:`,
          error
        );
        throw error;
      }
    },
    onToolsChanged: (listener) => {
      toolsChangedListeners.add(listener);
      return () => {
        toolsChangedListeners.delete(listener);
      };
    },
  };

  return {
    facade,
    disconnect: () => {
      rejectAll('page-tools bridge disposed');
      toolsChangedListeners.clear();
      try {
        port.disconnect();
      } catch {
        // Port 可能已断开
      }
    },
  };
}

interface TabEntry {
  client: ManagedTabSource;
  disposePort(): void;
  /** 展示用页面元数据（随导航同步）。 */
  meta: { url?: string; title?: string };
  /** 标记 Port 为主动断开（编排层释放时调用，自愈逻辑据此区分意外断连）。 */
  markIntentionalDisconnect(): void;
}

/**
 * 启动标签页源编排。返回：
 * - stop()：释放全部监听与连接（扩展卸载/SW 测试收尾用）；
 * - getStatuses()：当前全部标签页 relay 连接状态快照；
 * - onStatusChange(listener)：任一标签页状态变化时推送全量快照（侧栏展示用）。
 */
export function startTabSourceManager(options: TabSourceManagerOptions = {}): {
  stop(): void;
  getStatuses(): RelayTabStatus[];
  onStatusChange(listener: (statuses: RelayTabStatus[]) => void): () => void;
} {
  const tabsApi = options.tabsApi ?? defaultTabsApi();
  const tabFilter = options.tabFilter ?? isHttpUrl;
  const endpointCache = options.endpointCache ?? defaultEndpointCache();
  const hostHint = options.hostHint ?? '127.0.0.1';
  const portHint = options.portHint ?? 9333;

  const entries = new Map<number, TabEntry>();
  /** 各标签页最近一次连接状态（含展示元数据）。 */
  const statuses = new Map<number, RelayTabStatus>();
  const statusListeners = new Set<(statuses: RelayTabStatus[]) => void>();
  /** 各标签页 Port 自愈重试计数（导航完成时重置）。 */
  const recreateAttempts = new Map<number, number>();
  /** 待执行的自愈定时器（stop 时清理；导航完成时取消）。 */
  const healTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const snapshotStatuses = (): RelayTabStatus[] => [...statuses.values()].map((status) => ({ ...status }));

  const emitStatuses = (): void => {
    const snapshot = snapshotStatuses();
    for (const listener of statusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[webmcp-relay-source] status listener threw:', error);
      }
    }
  };

  const recordStatus = (tabId: number, status: RelayConnectionStatus): void => {
    const entry = entries.get(tabId);
    const next: RelayTabStatus = { ...status, tabId };
    if (entry?.meta.url !== undefined) next.url = entry.meta.url;
    if (entry?.meta.title !== undefined) next.title = entry.meta.title;
    statuses.set(tabId, next);
    emitStatuses();
  };

  // 异步缓存桥接为同步读：缓存写后驻内存，SW 冷启动首个客户端退化为全扫描（可接受）
  let cachedEndpoint: RelayEndpoint | null = null;
  void endpointCache.read().then((value) => {
    cachedEndpoint = value;
  });

  const clientFactory =
    options.clientFactory ??
    ((input: { tabId: number; source: RelaySourceMeta; facade: RelayToolsFacade }) => {
      // autoConnect: false —— 统一由编排层在登记后调用 start()
      return new RelaySourceClient({
        source: input.source,
        facade: input.facade,
        hostHint,
        portHint,
        autoConnect: false,
        readCachedEndpoint: () => cachedEndpoint,
        writeCachedEndpoint: (endpoint) => {
          cachedEndpoint = endpoint;
          void endpointCache.write(endpoint).catch(() => {
            // 缓存写入失败不影响主流程
          });
        },
        clearCachedEndpoint: () => {
          cachedEndpoint = null;
          void endpointCache.clear().catch(() => {
            // 缓存清理失败不影响主流程
          });
        },
        onReload: () => {
          void tabsApi.reload(input.tabId).catch((error: unknown) => {
            console.warn(`[webmcp-relay-source] tabs.reload(${String(input.tabId)}) failed:`, error);
          });
        },
      });
    });

  function disposeClient(tabId: number): void {
    const entry = entries.get(tabId);
    if (!entry) {
      return;
    }
    entry.markIntentionalDisconnect();
    entries.delete(tabId);
    entry.client.stop();
    entry.disposePort();
    if (statuses.delete(tabId)) {
      emitStatuses();
    }
  }

  /**
   * Port 意外断连自愈：延迟后（必要时先重注入 content scripts）重建整个
   * 客户端条目（dispose + ensure），RelaySourceClient 重新走发现握手。
   * 典型场景：
   * 1. 页面侧接收器未就绪 / 扩展重载后旧页面 content script 失效
   *    （"Receiving end does not exist"）→ 重注入 + 重建；
   * 2. 页面导航导致旧上下文 Port 死亡 → 仅重建（新页面由 manifest 注入）。
   * 指数退避（1s → 30s 封顶）防止对不可恢复页面形成风暴；导航完成时重置计数。
   */
  function healPort(tabId: number, reason: string): void {
    if (!entries.has(tabId) || healTimers.has(tabId)) {
      return;
    }
    const attempt = recreateAttempts.get(tabId) ?? 0;
    recreateAttempts.set(tabId, attempt + 1);
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    console.warn(
      `${DIAG_TAG} tab ${String(tabId)} page-tools Port 意外断连（${reason || 'unknown'}），` +
        `${String(delay)}ms 后自愈重建（第 ${String(attempt + 1)} 次）`
    );
    const timer = setTimeout(() => {
      healTimers.delete(tabId);
      const entry = entries.get(tabId);
      if (!entry) {
        return;
      }
      const { url, title } = entry.meta;
      const reinject = options.reinjectContentScripts ?? defaultReinjectContentScripts;
      void (async () => {
        if (/receiving end/i.test(reason)) {
          try {
            await reinject(tabId);
            console.info(`${DIAG_TAG} tab ${String(tabId)} content scripts 重注入完成`);
          } catch (error) {
            console.warn(
              `${DIAG_TAG} tab ${String(tabId)} content scripts 重注入失败（可能已注入或页面不可注入）:`,
              error
            );
          }
        }
        if (!entries.has(tabId)) {
          return;
        }
        disposeClient(tabId);
        ensureClient(tabId, url, title);
      })();
    }, delay);
    healTimers.set(tabId, timer);
  }

  function ensureClient(tabId: number, url: string | undefined, title: string | undefined): void {
    if (!tabFilter(url)) {
      if (url === undefined && !warnedUrlInvisible) {
        warnedUrlInvisible = true;
        console.warn(
          `${DIAG_TAG} tab ${String(tabId)} 的 URL 不可见（缺 "tabs" 权限或未授予 host 权限），` +
            '无法判定是否 http(s) 页面，跳过 relay 登记。修复：manifest 加 "tabs" 权限后重载扩展。'
        );
      }
      disposeClient(tabId);
      return;
    }
    if (entries.has(tabId)) {
      // 已有客户端：仅同步元数据（标题/URL 变化）
      const patch: Partial<RelaySourceMeta> = {};
      if (url !== undefined) patch.url = url;
      if (title !== undefined) patch.title = title;
      const origin = extractOrigin(url);
      if (origin !== undefined) patch.origin = origin;
      const entry = entries.get(tabId);
      if (entry) {
        if (url !== undefined) entry.meta.url = url;
        if (title !== undefined) entry.meta.title = title;
      }
      entries.get(tabId)?.client.updateSource(patch);
      return;
    }

    let port: chrome.runtime.Port;
    try {
      port = tabsApi.connect(tabId, { name: PAGE_TOOLS_PORT_NAME });
    } catch (error) {
      console.warn(`[webmcp-relay-source] tabs.connect(${String(tabId)}) failed:`, error);
      return;
    }
    // Port 意外断连自愈（disposeClient 主动断开时经 intentionalDisconnect 跳过）：
    // 页面侧无接收方（"Receiving end does not exist"）或导航导致旧上下文死亡时，
    // hello 握手会因 listTools 失败进入重连死循环，必须重建 Port 所在的整个客户端。
    let intentionalDisconnect = false;
    port.onDisconnect.addListener(() => {
      const lastError = safeChromeLastError();
      const message = lastError?.message ?? '';
      console.warn(
        `${DIAG_TAG} tab ${String(tabId)} page-tools Port 断连${message ? `: ${message}` : ''}` +
          (/receiving end/i.test(message)
            ? ' —— 页面侧无 content script 接收方，将自动重注入并重建'
            : '')
      );
      if (intentionalDisconnect) {
        return;
      }
      healPort(tabId, message);
    });
    const { facade, disconnect } = createPortToolsFacade(port, `tab ${String(tabId)}`);
    // exactOptionalPropertyTypes：可选字段仅在存在时写入，避免写入显式 undefined
    const origin = extractOrigin(url);
    const source: RelaySourceMeta = { tabId: String(tabId) };
    if (origin !== undefined) source.origin = origin;
    if (url !== undefined) source.url = url;
    if (title !== undefined) source.title = title;
    const meta: { url?: string; title?: string } = {};
    if (url !== undefined) meta.url = url;
    if (title !== undefined) meta.title = title;
    const client = clientFactory({ tabId, source, facade });
    client.onStatus((status) => recordStatus(tabId, status));
    client.start();
    entries.set(tabId, {
      client,
      disposePort: disconnect,
      meta,
      markIntentionalDisconnect: () => {
        intentionalDisconnect = true;
      },
    });
  }

  const onUpdated = (
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab: { id?: number; url?: string; title?: string }
  ): void => {
    // 仅在导航完成时（重）建立源：加载中建立会拿到未就绪的 content script
    if (changeInfo.status !== 'complete') {
      return;
    }
    // 新页面 = manifest 全新注入 content script，自愈成功率高：
    // 取消待执行的自愈并重置退避计数
    const pendingHeal = healTimers.get(tabId);
    if (pendingHeal !== undefined) {
      clearTimeout(pendingHeal);
      healTimers.delete(tabId);
    }
    recreateAttempts.delete(tabId);
    const url = changeInfo.url ?? tab.url;
    console.info(
      `${DIAG_TAG} 导航完成 tab ${String(tabId)}: changeInfo.url=${changeInfo.url ?? '<none>'}, tab.url=${tab.url ?? '<undefined>'} → 登记 URL=${url ?? '<undefined，将跳过>'}`
    );
    if (entries.has(tabId) && !tabFilter(url)) {
      disposeClient(tabId);
      return;
    }
    ensureClient(tabId, url, tab.title);
  };

  const onRemoved = (tabId: number): void => {
    disposeClient(tabId);
  };

  tabsApi.onUpdated.addListener(onUpdated);
  tabsApi.onRemoved.addListener(onRemoved);

  // SW 冷启动恢复：重扫已打开的 http(s) 标签页（SW 休眠会丢失内存态与连接，
  // 各源客户端会按自身状态机重新发现 relay）
  void tabsApi
    .query({ url: RESCAN_URL_PATTERNS })
    .then((tabs) => {
      console.info(
        `${DIAG_TAG} rescan（url 模式匹配）: ${String(tabs.length)} 个标签页` +
          (tabs.length > 0
            ? ` → ${JSON.stringify(tabs.map((tab) => ({ id: tab.id, url: tab.url ?? null })))}`
            : '（若浏览器明明开着 http(s) 页面却为 0，见下方诊断）')
      );
      if (tabs.length === 0) {
        void diagnoseUrlVisibility(tabsApi);
      }
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          ensureClient(tab.id, tab.url, tab.title);
        }
      }
    })
    .catch((error: unknown) => {
      console.warn('[webmcp-relay-source] tab rescan failed:', error);
    });

  return {
    stop: () => {
      tabsApi.onUpdated.removeListener(onUpdated);
      tabsApi.onRemoved.removeListener(onRemoved);
      for (const timer of healTimers.values()) {
        clearTimeout(timer);
      }
      healTimers.clear();
      for (const tabId of [...entries.keys()]) {
        disposeClient(tabId);
      }
    },
    getStatuses: snapshotStatuses,
    onStatusChange: (listener) => {
      statusListeners.add(listener);
      listener(snapshotStatuses());
      return () => {
        statusListeners.delete(listener);
      };
    },
  };
}

/**
 * 状态展示端口服务：侧边栏（扩展页面）通过 chrome.runtime.connect({name})
 * 建立长连接，SW 立即下发全量快照，此后任一标签页状态变化都推送更新。
 * runtime API 可注入（测试用桩）。
 */
export function startRelayStatusPort(
  manager: {
    getStatuses(): RelayTabStatus[];
    onStatusChange(listener: (statuses: RelayTabStatus[]) => void): () => void;
  },
  runtimeApi: Pick<typeof chrome.runtime, 'onConnect'> = chrome.runtime
): { stop(): void } {
  const onConnect = (port: chrome.runtime.Port): void => {
    if (port.name !== RELAY_STATUS_PORT_NAME) {
      return;
    }
    const send = (message: RelayStatusMessage): void => {
      try {
        port.postMessage(message);
      } catch {
        // Port 已断开（侧栏关闭），静默清理即可
      }
    };
    send({ type: 'snapshot', statuses: manager.getStatuses() });
    const unsubscribe = manager.onStatusChange((statuses) => {
      send({ type: 'update', statuses });
    });
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as Partial<RelayStatusRequest>;
      if (
        typeof message === 'object' &&
        message !== null &&
        message.type === 'subscribe'
      ) {
        send({ type: 'snapshot', statuses: manager.getStatuses() });
      }
    });
    port.onDisconnect.addListener(() => {
      unsubscribe();
    });
  };
  runtimeApi.onConnect.addListener(onConnect);
  return {
    stop: () => {
      runtimeApi.onConnect.removeListener(onConnect);
    },
  };
}
