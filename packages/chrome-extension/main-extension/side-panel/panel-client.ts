// 侧边栏侧的页面工具客户端：通过 chrome.runtime 长连接与 content script 桥接通信。
// 断线自动重连：Port 断开后，下一次请求前重新建立连接。
import {
  PAGE_TOOLS_PORT_NAME,
  type PageToolMeta,
  type PageToolsRequest,
  type PageToolsResponse,
} from '../../core/page-tools-bridge';

export interface PageToolsClient {
  /** 获取当前页面暴露的工具清单。 */
  listTools(): Promise<PageToolMeta[]>;
  /** 调用当前页面的某个工具。 */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 连接状态变化回调（返回取消订阅函数）。 */
  onStatusChange(listener: (connected: boolean) => void): () => void;
  /** 主动断开（侧边栏卸载时调用）。 */
  disconnect(): void;
}

/** 侧边栏设置（持久化到 chrome.storage.local）。 */
export interface PanelSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 调试模式：开启后侧栏出现「调试」Tab（手动执行工具，不经 LLM）。 */
  debugMode: boolean;
  /** 控制台输出：开启后日志同步打印到控制台（带 traceId 前缀）；默认关，仅写 IndexedDB。 */
  consoleOutput: boolean;
}

export const DEFAULT_SETTINGS: PanelSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  debugMode: false,
  consoleOutput: false,
};

const SETTINGS_KEYS = ['llmApiKey', 'llmBaseUrl', 'llmModel', 'debugMode', 'consoleOutput'] as const;

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

/** 断线重连：首次退避间隔与上限（指数退避）。 */
const RECONNECT_DELAY_INITIAL_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 15_000;
/** 重连探活 ping 的超时（远短于业务请求）。 */
const RECONNECT_PING_TIMEOUT_MS = 5_000;

/** 从 chrome.storage.local 读取设置，缺省项回退默认值。 */
export async function loadSettings(storage: {
  get: typeof chrome.storage.local.get;
} = chrome.storage.local): Promise<PanelSettings> {
  const stored = await storage.get([...SETTINGS_KEYS]);
  return {
    apiKey: typeof stored['llmApiKey'] === 'string' ? stored['llmApiKey'] : DEFAULT_SETTINGS.apiKey,
    baseUrl: typeof stored['llmBaseUrl'] === 'string' ? stored['llmBaseUrl'] : DEFAULT_SETTINGS.baseUrl,
    model: typeof stored['llmModel'] === 'string' ? stored['llmModel'] : DEFAULT_SETTINGS.model,
    debugMode: stored['debugMode'] === true,
    consoleOutput: stored['consoleOutput'] === true,
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
    llmModel: settings.model,
    debugMode: settings.debugMode,
    consoleOutput: settings.consoleOutput,
  });
}

/**
 * 建立页面工具客户端。
 *
 * 在线判定：Port 建立 ≠ 在线，收到该 Port 上的首条响应才置在线（避免接收端
 * 不存在时的在线/离线抖动）；断开或探活失败则置离线。
 *
 * 断线恢复策略：Port 断开后按指数退避（1s 起、15s 封顶）主动重连，重连以
 * listTools ping 成功为准；期间既有请求按原语义失败（拒绝并提示将重连）。
 *
 * @param portFactory 创建 Port 的工厂（默认 chrome.runtime.connect，测试可注入桩）
 * @param requestTimeoutMs 单请求超时（毫秒），默认 30s（工具执行可能较慢）
 */
export function connectPageTools(
  portFactory: () => chrome.runtime.Port = () => chrome.runtime.connect({ name: PAGE_TOOLS_PORT_NAME }),
  requestTimeoutMs = 30_000
): PageToolsClient {
  let port: chrome.runtime.Port | undefined;
  let connected = false;
  /** disconnect() 后置位，终止重连循环。 */
  let disposed = false;
  let nextId = 1;
  let reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, { resolve: (value: PageToolsResponse) => void; reject: (error: Error) => void }>();
  const statusListeners = new Set<(connected: boolean) => void>();

  const notifyStatus = (value: boolean): void => {
    connected = value;
    for (const listener of statusListeners) listener(value);
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (disposed || connected || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (disposed || connected) return;
      void verifyConnection();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
  };

  /** 重连探活：ping 一次 listTools，成功即恢复在线并重置退避。 */
  const verifyConnection = async (): Promise<void> => {
    if (disposed || connected) return;
    try {
      await request({ type: 'listTools' }, RECONNECT_PING_TIMEOUT_MS);
      // 成功路径无需处理：首条响应到达时 onMessage 已置在线并重置退避
    } catch {
      // 超时（Port 仍在）时主动断开以触发统一的 onDisconnect 清理；
      // 已断开（接收端不存在）场景 onDisconnect 内部已排定下一次尝试（幂等）
      port?.disconnect();
      port = undefined;
      if (connected) return; // 竞态兜底：响应恰好在超时后到达
      notifyStatus(false);
      scheduleReconnect();
    }
  };

  const ensurePort = (): chrome.runtime.Port => {
    if (port) return port;
    const fresh = portFactory();
    fresh.onMessage.addListener((message: unknown) => {
      const response = message as PageToolsResponse;
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      // 收到首条响应才算真正在线：避免 Port 建立即乐观置位造成的在线/离线抖动
      if (!connected) {
        reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
        notifyStatus(true);
      }
      waiter.resolve(response);
    });
    fresh.onDisconnect.addListener(() => {
      // 必须读取 lastError，否则 Chrome 打印 Unchecked runtime.lastError 告警
      const chromeError = consumeRuntimeLastError();
      port = undefined;
      const error = new Error(
        chromeError
          ? `与页面工具桥接的连接已断开（${chromeError}），将自动重连`
          : '与页面工具桥接的连接已断开（页面可能正在跳转），将自动重连'
      );
      for (const [, waiter] of pending) waiter.reject(error);
      pending.clear();
      notifyStatus(false);
      // 主动重连：content script 就绪晚于侧栏（或页面跳转后）也能自动恢复
      scheduleReconnect();
    });
    port = fresh;
    return fresh;
  };

  const request = (req: Omit<PageToolsRequest, 'id'>, timeoutMs: number = requestTimeoutMs): Promise<PageToolsResponse> => {
    const fresh = ensurePort();
    const id = nextId;
    nextId += 1;
    return new Promise<PageToolsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`页面工具请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      fresh.postMessage({ ...req, id } satisfies PageToolsRequest);
    });
  };

  return {
    async listTools() {
      const response = await request({ type: 'listTools' });
      if (!response.ok) throw new Error(response.error ?? 'listTools 失败');
      return response.result as PageToolMeta[];
    },
    async callTool(name, args) {
      const response = await request({ type: 'callTool', name, args });
      if (!response.ok) throw new Error(response.error ?? `调用工具 ${name} 失败`);
      return response.result;
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      listener(connected);
      return () => statusListeners.delete(listener);
    },
    disconnect() {
      disposed = true;
      clearReconnectTimer();
      port?.disconnect();
      port = undefined;
      notifyStatus(false);
    },
  };
}
