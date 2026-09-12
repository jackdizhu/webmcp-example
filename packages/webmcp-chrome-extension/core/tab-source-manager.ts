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
  applyInvokeLogEvent,
  RELAY_STATUS_PORT_NAME,
  type RelayInvokeLogEntry,
  type RelayInvokeLogPhase,
  type RelayStatusMessage,
  type RelayStatusRequest,
  type RelayTabSelection,
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
import {
  executeBuiltinTool,
  isBuiltinTool,
  mergeBuiltinWithPageTools,
  type BuiltinToolContext,
} from './builtin-tools';

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
  /**
   * 标签页数据源选择存储（默认 chrome.storage.local 的 relayTabSelection 键）。
   * 兼容读取旧 {mode, tabIds} 形态（取其 tabIds），新写入统一为 { tabIds }。
   */
  selectionStore?: {
    read(): Promise<RelayTabSelection | null>;
    write(value: RelayTabSelection): Promise<void>;
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
  /**
   * 通知 relay 移除本源注册（C.2 注册表一致性；RelaySourceClient 原生支持，
   * 可选以兼容旧测试桩）。
   */
  notifySourceDisconnected?(reason: string): void;
  /**
   * 手动重建 SW→relay 的 WebSocket 连接（「relay连接刷新」按钮；可选以兼容旧测试桩）。
   */
  reconnectRelay?(): void;
}

/** 本模块用到的 chrome.tabs API 最小面。 */
export interface TabsApi {
  get(tabId: number): Promise<{ id?: number; url?: string; title?: string }>;
  query(queryInfo: {
    url?: string[];
    active?: boolean;
    currentWindow?: boolean;
  }): Promise<Array<{ id?: number; url?: string; title?: string }>>;
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

/** chrome.storage.local 中标签页选择状态的键名。 */
const SELECTION_STORAGE_KEY = 'relayTabSelection';

/** 读取旧协议形态（{mode, tabIds}）与新形态（{tabIds}）共用的 tabIds。 */
function readStoredTabIds(value: unknown): number[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const tabIds = (value as { tabIds?: unknown }).tabIds;
  if (!Array.isArray(tabIds) || !tabIds.every((id) => typeof id === 'number')) return null;
  return tabIds as number[];
}

function defaultSelectionStore() {
  return {
    read: async (): Promise<RelayTabSelection | null> => {
      const stored = await chrome.storage.local.get([SELECTION_STORAGE_KEY]);
      const tabIds = readStoredTabIds(stored[SELECTION_STORAGE_KEY]);
      return tabIds ? { tabIds } : null;
    },
    write: async (value: RelayTabSelection): Promise<void> => {
      await chrome.storage.local.set({ [SELECTION_STORAGE_KEY]: value });
    },
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
  /**
   * Port 死亡标志（onDisconnect 或调用级归因置位，重建条目时复位）。
   * 修复导航完成竞态的关键：onUpdated(complete) 取消 healPort 延迟任务后，
   * ensureClient 的「已存在」分支原本仅同步元数据，死 Port 会永久留存 ——
   * 检测到该标志时必须走 dispose + 重建路径。
   */
  isPortDead(): boolean;
}

/**
 * 启动标签页源编排。返回：
 * - stop()：释放全部监听与连接（扩展卸载/SW 测试收尾用）；
 * - getStatuses()：当前全部标签页 relay 连接状态快照；
 * - onStatusChange(listener)：任一标签页状态变化时推送全量快照（侧栏展示用）；
 * - getInvokeLogs()：relay 工具调用日志环形缓冲（最近 INVOKE_LOG_CAP 条）；
 * - onInvokeLog(listener)：单次调用 started/finished 事件订阅；
 * - recordInvokeLog(phase, entry)：写入一条调用日志（默认 clientFactory 已接
 *   RelaySourceClient 回调；测试或自定义工厂可直接调用注入）。
 */
export function startTabSourceManager(options: TabSourceManagerOptions = {}): {
  stop(): void;
  getStatuses(): RelayTabStatus[];
  onStatusChange(listener: (statuses: RelayTabStatus[]) => void): () => void;
  /** 当前标签页数据源选择快照（自动模式单选活动页签 / 手动 checkbox 集合）。 */
  getSelection(): RelayTabSelection;
  /**
   * 更新全局标签页数据源选择（relay 页 checkbox 多选，全端生效）：
   * 仅选中页签建立连接（relay + 侧栏 agent/tools 调试目标）。
   */
  setSelection(tabIds: number[]): Promise<void>;
  /** 重置选择为「当前活动页签」（单选；侧栏打开时触发，覆盖手动多选）。 */
  resetSelection(): Promise<void>;
  /** 选择变化订阅（订阅即收到一次当前快照）。 */
  onSelectionChange(listener: (selection: RelayTabSelection) => void): () => void;
  getInvokeLogs(): RelayInvokeLogEntry[];
  onInvokeLog(listener: (phase: RelayInvokeLogPhase, entry: RelayInvokeLogEntry) => void): () => void;
  recordInvokeLog(phase: RelayInvokeLogPhase, entry: RelayInvokeLogEntry): void;
  /**
   * 手动刷新当前活动标签页的连接（侧栏调试页按钮）：
   * - 'webmcp'：强制重建 SW→页面 Port + 客户端条目；
   * - 'relay'：仅重建 SW→relay 的 WebSocket。
   * 返回 false 表示目标标签页未登记或操作失败。
   */
  recreateConnectionForActive(mode: 'webmcp' | 'relay'): Promise<boolean>;
} {
  const tabsApi = options.tabsApi ?? defaultTabsApi();
  const tabFilter = options.tabFilter ?? isHttpUrl;
  const endpointCache = options.endpointCache ?? defaultEndpointCache();
  const selectionStore = options.selectionStore ?? defaultSelectionStore();
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

  // ---- 全局标签页数据源选择（2026-09-12：单一事实源，全端生效）----
  // 语义：默认 = 启动/重置时的活动页签（单选）；不随 onActivated 自动跟随；
  // 增删选中项仅经 setSelection（relay 页 checkbox，agent/tools 调试目标同步）；
  // 侧栏打开经 resetSelection 重置（Q5：侧栏重开 = 回到默认单选）。
  /** 全部可连接（http(s)）标签页清单：侧栏 checkbox 列表的数据源（含未选中页签）。 */
  const inventory = new Map<number, { url?: string; title?: string }>();
  /** 选中集合（init 完成前 ensureClient 全部被门控，避免冷启动竞态连错页签）。 */
  let selectedTabIds = new Set<number>();
  let selectionReady = false;
  /** initSelection 完成承诺：setSelection/resetSelection 须等待其结束，避免默认选择覆盖用户设置。 */
  let selectionInitPromise: Promise<void> = Promise.resolve();
  const selectionListeners = new Set<(selection: RelayTabSelection) => void>();

  const getSelection = (): RelayTabSelection => ({ tabIds: [...selectedTabIds] });

  const emitSelection = (): void => {
    const snapshot = getSelection();
    for (const listener of selectionListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[webmcp-relay-source] selection listener threw:', error);
      }
    }
  };

  const persistSelection = async (): Promise<void> => {
    try {
      await selectionStore.write(getSelection());
    } catch (error) {
      console.warn('[webmcp-relay-source] selection persist failed:', error);
    }
  };

  /**
   * 按选中集合对齐连接：释放未选中的已连条目，建立选中且未连的条目；
   * 随后持久化选择状态并推送快照。幂等，可重复调用。
   */
  async function reconcileSelection(): Promise<void> {
    if (!selectionReady) {
      return;
    }
    for (const tabId of [...entries.keys()]) {
      if (!selectedTabIds.has(tabId)) {
        disposeClient(tabId);
      }
    }
    // 存储里可能残留已关闭标签页：get 失败即从选中集合清理
    const stale: number[] = [];
    for (const tabId of selectedTabIds) {
      if (entries.has(tabId)) {
        continue;
      }
      // 优先读 inventory（ensureClient 登记时已记录 url/title）：tabsApi.get 在
      // 部分场景拿不到 URL 或失败，避免把仍存在的选中页签误判为 stale
      const inv = inventory.get(tabId);
      if (inv) {
        ensureClient(tabId, inv.url, inv.title);
        continue;
      }
      try {
        const tab = await tabsApi.get(tabId);
        if (tab.id === undefined) {
          stale.push(tabId);
          continue;
        }
        ensureClient(tab.id, tab.url, tab.title);
      } catch {
        stale.push(tabId);
      }
    }
    for (const tabId of stale) {
      selectedTabIds.delete(tabId);
    }
    await persistSelection();
    emitSelection();
    emitStatuses();
  }

  /**
   * 启动时恢复选择状态（SW 冷启动自愈）：存储存在且非空 → 沿用；
   * 否则取当前活动页签（单选）。注意：侧栏打开时会再触发 resetSelection，
   * 此处沿用仅覆盖「SW 运行中重启、侧栏未动」的场景。
   */
  async function initSelection(): Promise<void> {
    selectedTabIds = new Set();
    try {
      const stored = await selectionStore.read();
      if (stored && stored.tabIds.length > 0) {
        selectedTabIds = new Set(stored.tabIds);
      }
    } catch (error) {
      console.warn('[webmcp-relay-source] selection read failed:', error);
    }
    if (selectedTabIds.size === 0) {
      const activeTabId = await getActiveTabId();
      if (activeTabId !== null) {
        selectedTabIds = new Set([activeTabId]);
      }
    }
    selectionReady = true;
    await reconcileSelection();
  }

  /**
   * 更新全局标签页数据源选择（relay 页 checkbox 多选，全端生效）：
   * 仅选中页签建立连接；未选中的已连条目立即释放。
   */
  async function setSelection(tabIds: number[]): Promise<void> {
    // 启动竞态保护：initSelection 未完成时其默认选择会覆盖本次设置
    await selectionInitPromise;
    selectedTabIds = new Set(tabIds);
    await reconcileSelection();
  }

  /**
   * 重置选择为「当前活动页签」（单选）。触发点：侧栏打开（onMounted 经
   * reset-selection 请求）；覆盖既有手动多选集合（Q5 决策）。
   */
  async function resetSelection(): Promise<void> {
    await selectionInitPromise;
    const activeTabId = await getActiveTabId();
    selectedTabIds = new Set(activeTabId !== null ? [activeTabId] : []);
    await reconcileSelection();
  }

  // relay 调用日志：环形缓冲 + 订阅（侧栏「relay 调用」页只读展示的数据源）
  let invokeLogs: RelayInvokeLogEntry[] = [];
  const invokeLogListeners = new Set<
    (phase: RelayInvokeLogPhase, entry: RelayInvokeLogEntry) => void
  >();

  const recordInvokeLog = (phase: RelayInvokeLogPhase, entry: RelayInvokeLogEntry): void => {
    invokeLogs = applyInvokeLogEvent(invokeLogs, phase, entry);
    for (const listener of invokeLogListeners) {
      try {
        listener(phase, { ...entry });
      } catch (error) {
        console.warn('[webmcp-relay-source] invoke-log listener threw:', error);
      }
    }
  };

  /**
   * 全量标签页快照：已连接条目用真实连接状态 + selected 标记；
   * inventory 中未连接的 http(s) 页签合成 stopped 占位（侧栏 checkbox 列表数据源）。
   */
  const snapshotStatuses = (): RelayTabStatus[] => {
    const out: RelayTabStatus[] = [];
    const seen = new Set<number>();
    for (const [tabId, status] of statuses) {
      out.push({ ...status, tabId, selected: selectedTabIds.has(tabId) });
      seen.add(tabId);
    }
    for (const [tabId, meta] of inventory) {
      if (seen.has(tabId)) {
        continue;
      }
      const next: RelayTabStatus = {
        state: 'stopped',
        endpoint: null,
        toolsCount: 0,
        updatedAt: 0,
        tabId,
        selected: selectedTabIds.has(tabId),
      };
      if (meta.url !== undefined) next.url = meta.url;
      if (meta.title !== undefined) next.title = meta.title;
      out.push(next);
    }
    return out;
  };

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

  // 内置工具执行上下文：选中集合即「当前选中页签」（Q4：每选中页签一个元素）
  const builtinContext: BuiltinToolContext = {
    getSelectedTabIds: () => [...selectedTabIds],
  };

  const clientFactory =
    options.clientFactory ??
    ((input: { tabId: number; source: RelaySourceMeta; facade: RelayToolsFacade }) => {
      // 内置工具合并（Q6 双端统一）：listTools 内置描述在前（页面占用内置命名空间的剔除），
      // callTool 内置名优先路由 —— 外部 MCP 客户端经 relay 也能调用内置工具。
      // 内置工具返回 MCP CallToolResult（executeBuiltinTool 内部已包装），
      // 与页面工具同构，relay 的 CallToolResultSchema 校验可原样通过
      const pageFacade = input.facade;
      const facadeWithBuiltins: RelayToolsFacade = {
        listTools: async () => mergeBuiltinWithPageTools(await pageFacade.listTools()),
        callTool: (name, args) => {
          if (isBuiltinTool(name)) {
            return executeBuiltinTool(name, args, builtinContext);
          }
          return pageFacade.callTool(name, args);
        },
        onToolsChanged: pageFacade.onToolsChanged,
      };
      // autoConnect: false —— 统一由编排层在登记后调用 start()
      return new RelaySourceClient({
        source: input.source,
        facade: facadeWithBuiltins,
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
        onPortDead: (reason) => {
          handlePortDead(input.tabId, reason);
        },
        onInvokeLog: (phase, draft) => {
          recordInvokeLog(phase, { ...draft, tabId: input.tabId });
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
   * Port 死亡统一处理：先趁 WebSocket 存活通知 relay 移除本源注册（C.2，
   * 消除「list_tools 看着正常、调必失败」的注册表漂移），再启动自愈重建。
   * healPort 内部有 healTimers 防重入，重复触发安全。
   */
  function handlePortDead(tabId: number, reason: string): void {
    const entry = entries.get(tabId);
    if (!entry) {
      return;
    }
    try {
      entry.client.notifySourceDisconnected?.(reason);
    } catch (error) {
      console.warn(`${DIAG_TAG} tab ${String(tabId)} notifySourceDisconnected failed:`, error);
    }
    healPort(tabId, reason);
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
    // 全量标签页清单：无论是否选中都记录（侧栏 checkbox 列表展示用）
    const invMeta = inventory.get(tabId) ?? {};
    if (url !== undefined) invMeta.url = url;
    if (title !== undefined) invMeta.title = title;
    inventory.set(tabId, invMeta);

    // 选择门控：未选中的标签页不建立 SW→relay 连接 —— relay 端 list_sources /
    // list_tools / invoke 获取不到其数据（过滤不传递）；已连接的条目立即释放。
    if (!selectionReady || !selectedTabIds.has(tabId)) {
      if (entries.has(tabId)) {
        disposeClient(tabId);
      } else {
        emitStatuses();
      }
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
    // Port 死亡标志（竞态修复）：onUpdated(complete) 可能先于 healPort 延迟任务
    // 执行并取消自愈 —— 此时 entry 仍持有死 Port，导航完成路径据此强制重建。
    let portDead = false;
    port.onDisconnect.addListener(() => {
      const lastError = safeChromeLastError();
      const message = lastError?.message ?? '';
      portDead = true;
      console.warn(
        `${DIAG_TAG} tab ${String(tabId)} page-tools Port 断连${message ? `: ${message}` : ''}` +
          (/receiving end/i.test(message)
            ? ' —— 页面侧无 content script 接收方，将自动重注入并重建'
            : '')
      );
      if (intentionalDisconnect) {
        return;
      }
      handlePortDead(tabId, message);
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
      isPortDead: () => portDead,
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
    // 竞态修复：Port 死亡事件先于导航完成时，healPort 延迟任务被上面取消，
    // entry 里残留死 Port —— ensureClient 的「已存在」分支只同步元数据不会重建，
    // 死 Port 将永久留存（所有 invoke 报 disconnected port）。检测到必须强制重建。
    if (entries.get(tabId)?.isPortDead()) {
      console.info(`${DIAG_TAG} tab ${String(tabId)} 导航完成发现死 Port 残留 → 强制重建客户端`);
      disposeClient(tabId);
    }
    if (entries.has(tabId) && !tabFilter(url)) {
      disposeClient(tabId);
      return;
    }
    ensureClient(tabId, url, tab.title);
  };

  // R2/R3 决策：不再监听 tabs.onActivated —— 选中集合不随活动页签切换变化，
  // 改连新页签只能经 setSelection（手动 checkbox）或 resetSelection（侧栏重开）。

  const onRemoved = (tabId: number): void => {
    inventory.delete(tabId);
    // 已选中的标签页被关闭：从选中集合清理并持久化
    if (selectedTabIds.delete(tabId)) {
      void persistSelection();
      emitSelection();
    }
    disposeClient(tabId);
  };

  tabsApi.onUpdated.addListener(onUpdated);
  tabsApi.onRemoved.addListener(onRemoved);

  // SW 冷启动恢复：重扫已打开的 http(s) 标签页建立全量清单（未选中的只登记不连接，
  // 选中的各源客户端按自身状态机重新发现 relay）
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

  // 恢复全局标签页数据源选择：存储沿用（SW 运行中重启自愈），
  // 否则取当前活动页签（单选）；侧栏打开时会再触发 resetSelection 重置
  selectionInitPromise = initSelection();

  /**
   * 手动重建指定标签页的连接（侧栏刷新按钮入口）：
   * - webmcp：强制销毁整个客户端条目（Port + RelaySourceClient）后全新重建，
   *   不依赖 Port 死亡事件，对「死 Port 残留」状态始终有效；
   * - relay：仅重建 SW→relay 的 WebSocket（重新发现握手），Port 保持不动。
   */
  async function recreateConnection(tabId: number, mode: 'webmcp' | 'relay'): Promise<boolean> {
    const entry = entries.get(tabId);
    if (!entry) {
      console.warn(`${DIAG_TAG} recreateConnection: tab ${String(tabId)} 未登记，跳过`);
      return false;
    }
    if (mode === 'relay') {
      try {
        entry.client.reconnectRelay?.();
        return true;
      } catch (error) {
        console.warn(`${DIAG_TAG} tab ${String(tabId)} reconnectRelay failed:`, error);
        return false;
      }
    }
    const { url, title } = entry.meta;
    console.info(`${DIAG_TAG} tab ${String(tabId)} 手动重建 webmcp 连接（Port + 客户端）`);
    recreateAttempts.delete(tabId);
    const pendingHeal = healTimers.get(tabId);
    if (pendingHeal !== undefined) {
      clearTimeout(pendingHeal);
      healTimers.delete(tabId);
    }
    disposeClient(tabId);
    ensureClient(tabId, url, title);
    return true;
  }

  /** 取当前窗口活动标签页 id（手动刷新按钮目标；取不到返回 null）。 */
  async function getActiveTabId(): Promise<number | null> {
    try {
      const tabs = await tabsApi.query({ active: true, currentWindow: true });
      const active = tabs.find((tab) => tab.id !== undefined);
      return active?.id ?? null;
    } catch (error) {
      console.warn(`${DIAG_TAG} 获取活动标签页失败:`, error);
      return null;
    }
  }

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
    getSelection,
    setSelection: (tabIds: number[]) => setSelection(tabIds),
    resetSelection: () => resetSelection(),
    onSelectionChange: (listener) => {
      selectionListeners.add(listener);
      listener(getSelection());
      return () => {
        selectionListeners.delete(listener);
      };
    },
    onStatusChange: (listener) => {
      statusListeners.add(listener);
      listener(snapshotStatuses());
      return () => {
        statusListeners.delete(listener);
      };
    },
    getInvokeLogs: () => invokeLogs.map((entry) => ({ ...entry })),
    onInvokeLog: (listener) => {
      invokeLogListeners.add(listener);
      return () => {
        invokeLogListeners.delete(listener);
      };
    },
    recordInvokeLog,
    /**
     * 手动刷新当前活动标签页的连接（侧栏调试页按钮）。
     * 返回 false 表示目标标签页未登记或操作失败。
     */
    recreateConnectionForActive: async (mode: 'webmcp' | 'relay'): Promise<boolean> => {
      const tabId = await getActiveTabId();
      if (tabId === null) {
        return false;
      }
      return recreateConnection(tabId, mode);
    },
  };
}

/**
 * 状态展示端口服务：侧边栏（扩展页面）通过 chrome.runtime.connect({name})
 * 建立长连接，SW 立即下发全量快照，此后任一标签页状态变化都推送更新。
 * 同时推送 relay 工具调用日志（invoke-logs 全量 + invoke-log 增量）。
 * runtime API 可注入（测试用桩）。
 */
export function startRelayStatusPort(
  manager: {
    getStatuses(): RelayTabStatus[];
    onStatusChange(listener: (statuses: RelayTabStatus[]) => void): () => void;
    getInvokeLogs?(): RelayInvokeLogEntry[];
    onInvokeLog?(listener: (phase: RelayInvokeLogPhase, entry: RelayInvokeLogEntry) => void): () => void;
    /** 手动刷新活动标签页连接（调试页「webmcp连接刷新 / relay连接刷新」按钮）。 */
    recreateConnectionForActive?(mode: 'webmcp' | 'relay'): Promise<boolean>;
    /** 全局标签页数据源选择快照（缺失时侧栏不展示选择能力，向后兼容）。 */
    getSelection?(): RelayTabSelection;
    /** 更新全局标签页数据源选择（relay 页 checkbox 多选，全端生效）。 */
    setSelection?(tabIds: number[]): void | Promise<void>;
    /** 重置选择为当前活动页签（侧栏打开时触发；缺失时侧栏不重置）。 */
    resetSelection?(): void | Promise<void>;
    /** 选择变化订阅（变化时经状态端口推送 selection 消息）。 */
    onSelectionChange?(listener: (selection: RelayTabSelection) => void): () => void;
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
    const sendSelection = (): void => {
      const selection = manager.getSelection?.();
      if (selection) {
        send({ type: 'selection', tabIds: selection.tabIds });
      }
    };
    send({ type: 'snapshot', statuses: manager.getStatuses() });
    sendSelection();
    const invokeLogs = manager.getInvokeLogs?.();
    if (invokeLogs) {
      send({ type: 'invoke-logs', entries: invokeLogs });
    }
    const unsubscribe = manager.onStatusChange((statuses) => {
      send({ type: 'update', statuses });
    });
    const unsubscribeSelection = manager.onSelectionChange?.((selection) => {
      send({ type: 'selection', tabIds: selection.tabIds });
    });
    const unsubscribeInvokeLog = manager.onInvokeLog?.((phase, entry) => {
      send({ type: 'invoke-log', phase, entry });
    });
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as Partial<RelayStatusRequest>;
      if (
        typeof message === 'object' &&
        message !== null &&
        message.type === 'subscribe'
      ) {
        send({ type: 'snapshot', statuses: manager.getStatuses() });
        sendSelection();
        return;
      }
      // 全局标签页数据源选择（Q6 多选全端生效）：数组 = 新选中集合；
      // 连接增删结果经状态快照自动推送
      if (
        typeof message === 'object' &&
        message !== null &&
        message.type === 'set-selection'
      ) {
        const tabIds = (message as { tabIds?: unknown }).tabIds;
        if (Array.isArray(tabIds) && tabIds.every((id) => typeof id === 'number')) {
          void manager.setSelection?.(tabIds as number[]);
        } else {
          console.warn('[webmcp-relay-source] invalid set-selection payload, ignored');
        }
        return;
      }
      // 重置选择为当前活动页签（单选；侧栏打开 onMounted 触发，覆盖手动多选，Q5）
      if (
        typeof message === 'object' &&
        message !== null &&
        message.type === 'reset-selection'
      ) {
        void manager.resetSelection?.();
        return;
      }
      // 手动刷新按钮：重建活动标签页的 SW→页面 Port 或 SW→relay WebSocket；
      // 结果经状态快照自动推送（重建过程中的状态迁移会触发 onStatusChange）
      if (
        typeof message === 'object' &&
        message !== null &&
        (message.type === 'webmcp-reconnect' || message.type === 'relay-reconnect')
      ) {
        const mode = message.type === 'webmcp-reconnect' ? 'webmcp' : 'relay';
        void manager.recreateConnectionForActive?.(mode);
      }
    });
    port.onDisconnect.addListener(() => {
      unsubscribe();
      unsubscribeSelection?.();
      unsubscribeInvokeLog?.();
    });
  };
  runtimeApi.onConnect.addListener(onConnect);
  return {
    stop: () => {
      runtimeApi.onConnect.removeListener(onConnect);
    },
  };
}
