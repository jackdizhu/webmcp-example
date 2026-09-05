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
 * @param portFactory 创建 Port 的工厂（默认 chrome.runtime.connect，测试可注入桩）
 * @param requestTimeoutMs 单请求超时（毫秒），默认 30s（工具执行可能较慢）
 */
export function connectPageTools(
  portFactory: () => chrome.runtime.Port = () => chrome.runtime.connect({ name: PAGE_TOOLS_PORT_NAME }),
  requestTimeoutMs = 30_000
): PageToolsClient {
  let port: chrome.runtime.Port | undefined;
  let connected = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: PageToolsResponse) => void; reject: (error: Error) => void }>();
  const statusListeners = new Set<(connected: boolean) => void>();

  const notifyStatus = (value: boolean): void => {
    connected = value;
    for (const listener of statusListeners) listener(value);
  };

  const ensurePort = (): chrome.runtime.Port => {
    if (port && connected) return port;
    if (port) {
      // 清理旧端口的监听（断开时 Chrome 会自动触发 onDisconnect，防御性兜底）
      port = undefined;
    }
    const fresh = portFactory();
    fresh.onMessage.addListener((message: unknown) => {
      const response = message as PageToolsResponse;
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      waiter.resolve(response);
    });
    fresh.onDisconnect.addListener(() => {
      const error = new Error('与页面工具桥接的连接已断开（页面可能正在跳转），将自动重连');
      for (const [, waiter] of pending) waiter.reject(error);
      pending.clear();
      notifyStatus(false);
    });
    port = fresh;
    notifyStatus(true);
    return fresh;
  };

  const request = (req: Omit<PageToolsRequest, 'id'>): Promise<PageToolsResponse> => {
    const fresh = ensurePort();
    const id = nextId;
    nextId += 1;
    return new Promise<PageToolsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`页面工具请求超时（${requestTimeoutMs}ms）`));
      }, requestTimeoutMs);
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
      port?.disconnect();
      port = undefined;
      notifyStatus(false);
    },
  };
}
