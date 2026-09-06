// 侧边栏侧的 relay 连接状态客户端：经 chrome.runtime.connect 长连接订阅
// SW 内各标签页的 relay 连接状态（协议见 core/relay-status-protocol.ts）。
// 通道说明：扩展页面 → SW 用 runtime.connect（与 page-tools 桥接的
// tabs.connect → content script 方向相反）；连接本身会唤醒 SW。
// 断线自动重连：SW 休眠/重启后 Port 断开，按指数退避重连，重连成功即收到新快照。
import {
  applyInvokeLogEvent,
  RELAY_STATUS_PORT_NAME,
  type RelayInvokeLogEntry,
  type RelayStatusMessage,
  type RelayStatusRequest,
  type RelayTabSelection,
  type RelayTabStatus,
} from '../../core/relay-status-protocol';

export interface RelayStatusClient {
  /** 最近一次全量状态快照。 */
  getStatuses(): RelayTabStatus[];
  /** 快照更新回调（连接建立即触发一次，返回取消订阅函数）。 */
  onUpdate(listener: (statuses: RelayTabStatus[]) => void): () => void;
  /** relay 调用日志缓冲（连接建立时以 SW 快照对齐，此后增量合并）。 */
  getInvokeLogs(): RelayInvokeLogEntry[];
  /** 调用日志变化回调（快照对齐或增量事件后触发，参数为最新全量数组）。 */
  onInvokeLogs(listener: (entries: RelayInvokeLogEntry[]) => void): () => void;
  /** 最近一次标签页数据源选择快照（SW 推送；连接前为默认自动模式空集）。 */
  getSelection(): RelayTabSelection;
  /** 标签页数据源选择变化回调（订阅即触发一次，返回取消订阅函数）。 */
  onSelectionChange(listener: (selection: RelayTabSelection) => void): () => void;
  /**
   * 向 SW 发送控制请求（手动刷新连接 / 更新标签页选择等）。连接未就绪时静默丢弃 ——
   * 刷新与选择类操作语义幂等，重连成功后再点一次即可。
   */
  sendRequest(request: RelayStatusRequest): void;
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
  let invokeLogs: RelayInvokeLogEntry[] = [];
  let selection: RelayTabSelection = { mode: 'auto', tabIds: [] };
  let reconnectDelayMs = RECONNECT_DELAY_INITIAL_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(statuses: RelayTabStatus[]) => void>();
  const invokeLogListeners = new Set<(entries: RelayInvokeLogEntry[]) => void>();
  const selectionListeners = new Set<(selection: RelayTabSelection) => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener(statuses);
    }
  };

  const notifyInvokeLogs = (): void => {
    for (const listener of invokeLogListeners) {
      listener(invokeLogs);
    }
  };

  const notifySelection = (): void => {
    for (const listener of selectionListeners) {
      listener(selection);
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
        return;
      }
      if (typeof msg === 'object' && msg !== null && msg.type === 'invoke-logs') {
        // 全量对齐：以 SW 环形缓冲为准（重连后去重，直接替换）
        if (Array.isArray(msg.entries)) {
          invokeLogs = msg.entries.map((entry) => ({ ...entry }));
          notifyInvokeLogs();
        }
        return;
      }
      if (typeof msg === 'object' && msg !== null && msg.type === 'selection') {
        const tabIds = msg.tabIds;
        if ((msg.mode === 'auto' || msg.mode === 'manual') && Array.isArray(tabIds)) {
          selection = { mode: msg.mode, tabIds: tabIds.filter((id) => typeof id === 'number') };
          notifySelection();
        }
        return;
      }
      if (typeof msg === 'object' && msg !== null && msg.type === 'invoke-log') {
        if (msg.phase === 'started' || msg.phase === 'finished') {
          invokeLogs = applyInvokeLogEvent(invokeLogs, msg.phase, msg.entry);
          notifyInvokeLogs();
        }
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
    getInvokeLogs: () => invokeLogs.map((entry) => ({ ...entry })),
    onInvokeLogs(listener) {
      invokeLogListeners.add(listener);
      listener(invokeLogs);
      return () => {
        invokeLogListeners.delete(listener);
      };
    },
    getSelection: () => ({ mode: selection.mode, tabIds: [...selection.tabIds] }),
    onSelectionChange(listener) {
      selectionListeners.add(listener);
      listener(selection);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    sendRequest(request: RelayStatusRequest): void {
      if (!port || disposed) {
        console.debug('[relay-status] sendRequest ignored: port not ready', request.type);
        return;
      }
      try {
        port.postMessage(request);
      } catch (error) {
        console.warn('[relay-status] sendRequest failed:', error);
      }
    },
    disconnect() {
      disposed = true;
      clearReconnectTimer();
      port?.disconnect();
      port = null;
    },
  };
}
