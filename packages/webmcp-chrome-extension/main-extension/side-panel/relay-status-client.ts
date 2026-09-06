// 侧边栏侧的 relay 连接状态客户端：经 chrome.runtime.connect 长连接订阅
// SW 内各标签页的 relay 连接状态（协议见 core/relay-status-protocol.ts）。
// 通道说明：扩展页面 → SW 用 runtime.connect（与 page-tools 桥接的
// tabs.connect → content script 方向相反）；连接本身会唤醒 SW。
// 断线自动重连：SW 休眠/重启后 Port 断开，按指数退避重连，重连成功即收到新快照。
import {
  RELAY_STATUS_PORT_NAME,
  type RelayStatusMessage,
  type RelayTabStatus,
} from '../../core/relay-status-protocol';

export interface RelayStatusClient {
  /** 最近一次全量状态快照。 */
  getStatuses(): RelayTabStatus[];
  /** 快照更新回调（连接建立即触发一次，返回取消订阅函数）。 */
  onUpdate(listener: (statuses: RelayTabStatus[]) => void): () => void;
  /** 主动断开（侧边栏卸载时调用）。 */
  disconnect(): void;
}

/** 断线重连：首次退避间隔与上限（指数退避）。 */
const RECONNECT_DELAY_INITIAL_MS = 2_000;
const RECONNECT_DELAY_MAX_MS = 30_000;

/** 读取并消费 chrome.runtime.lastError（未消费会打 Unchecked 告警，见 panel-client）。 */
function consumeRuntimeLastError(): string | undefined {
  const chromeGlobal = (globalThis as {
    chrome?: { runtime?: { lastError?: { message?: string } } };
  }).chrome;
  return chromeGlobal?.runtime?.lastError?.message;
}

/**
 * 建立 relay 状态订阅客户端。
 * @param portFactory 创建 Port 的工厂（默认 runtime.connect 状态端口，测试可注入桩）
 */
export function connectRelayStatus(
  portFactory: () => chrome.runtime.Port = () =>
    chrome.runtime.connect({ name: RELAY_STATUS_PORT_NAME })
): RelayStatusClient {
  let port: chrome.runtime.Port | null = null;
  let disposed = false;
  let statuses: RelayTabStatus[] = [];
  let reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(statuses: RelayTabStatus[]) => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener(statuses);
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (disposed || port || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (disposed || port) return;
      connectNow();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
  };

  const attachPort = (fresh: chrome.runtime.Port): void => {
    fresh.onMessage.addListener((message: unknown) => {
      const msg = message as RelayStatusMessage;
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg.type === 'snapshot' || msg.type === 'update') &&
        Array.isArray(msg.statuses)
      ) {
        statuses = msg.statuses;
        reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
        notify();
      }
    });
    fresh.onDisconnect.addListener(() => {
      // 必须读取 lastError，否则 Chrome 打印 Unchecked runtime.lastError 告警
      const chromeError = consumeRuntimeLastError();
      port = null;
      if (disposed) return;
      // SW 休眠/重启或状态端口未就绪：退避后重连，重连成功即对齐新快照
      console.debug(
        `[relay-status] port disconnected${chromeError ? ` (${chromeError})` : ''}, reconnecting in ${String(reconnectDelayMs)}ms`
      );
      scheduleReconnect();
    });
    port = fresh;
  };

  const connectNow = (): void => {
    if (disposed || port) return;
    try {
      attachPort(portFactory());
    } catch {
      scheduleReconnect();
    }
  };

  connectNow();

  return {
    getStatuses: () => statuses,
    onUpdate(listener) {
      listeners.add(listener);
      listener(statuses);
      return () => {
        listeners.delete(listener);
      };
    },
    disconnect() {
      disposed = true;
      clearReconnectTimer();
      port?.disconnect();
      port = null;
    },
  };
}
