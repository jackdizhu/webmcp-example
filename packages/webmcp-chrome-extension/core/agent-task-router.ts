// Tab 反调通道的 SW 路由（C5 反向通道第 3 跳，D4 决策：SW 只路由不执行）。
//
// 职责：
// 1. 监听两类 Port：页签侧（AGENT_TASK_TAB_PORT_NAME，来自 content script）与
//    宿主侧（AGENT_TASK_HOST_PORT_NAME，来自侧边栏 agent-task-host）；
// 2. 注入可信来源：sender.tabId / sender.origin 一律取自 chrome 端口（Port.sender），
//    页面自报的任何来源字段不采信（§6 安全基线）；
// 3. origin 白名单闸门（Q5）：tabInvokeAllowlist（chrome.storage.local，字符串数组，
//    精确 origin 匹配）——默认拒绝；未命中直接回 ORIGIN_NOT_ALLOWED，不触达宿主；
// 4. requestId ↔ 页签 Port 关联：宿主应答（ack/done/error）按 requestId 路由回发起页签；
//    宿主断开时在途请求统一补偿 EXTENSION_HOST_UNAVAILABLE。
//
// SW 休眠语义：SW 重启后本模块由 service-worker.ts 顶层重新注册，映射表清空 ——
// 断开的 Port 会触发页签桥接失联补偿（页面 Promise 落定），不存在跨 SW 生命周期的悬挂状态。
// cancel-task 为 v2 预留（§3.5）：本期直接回 PROTOCOL_MISMATCH。
import {
  AGENT_TASK_HOST_PORT_NAME,
  AGENT_TASK_TAB_PORT_NAME,
  TAB_INVOKE_ALLOWLIST_KEY,
  isAgentTaskHostReplyMessage,
  isAgentTaskTabMessage,
  type AgentTaskErrorMessage,
  type AgentTaskHostReplyMessage,
  type AgentTaskRoutedCreateMessage,
} from './agent-task-protocol';

/** 页签连接元数据（可信来源 + 该连接的在途请求集合）。 */
interface TabConnection {
  tabId: number;
  origin: string;
  requests: Set<string>;
}

/** 消费 chrome.runtime.lastError（同 panel-client 口径，避免Unchecked 告警）。 */
function consumeRuntimeLastError(): string | undefined {
  const chromeGlobal = (globalThis as {
    chrome?: { runtime?: { lastError?: { message?: string } } };
  }).chrome;
  return chromeGlobal?.runtime?.lastError?.message;
}

/**
 * 启动反调路由（SW 顶层调用一次；每次 SW 唤醒重建监听与映射）。
 *
 * @returns 停止句柄：移除 onConnect / storage 监听并断开全部 Port（测试用）
 */
export function startAgentTaskRouter(): { stop(): void } {
  const tabs = new Map<chrome.runtime.Port, TabConnection>();
  /** requestId → 发起页签 Port（create-task 转发时登记，终态应答后移除）。 */
  const requestPorts = new Map<string, chrome.runtime.Port>();
  /** 宿主 Port（侧边栏 agent-task-host；后连者替换前者，旧连接在途请求补偿）。 */
  let hostPort: chrome.runtime.Port | null = null;
  /** origin 白名单缓存（默认空 = 全部拒绝；onChanged 即时刷新）。 */
  let allowlist = new Set<string>();

  const replyToTab = (port: chrome.runtime.Port, message: AgentTaskHostReplyMessage): void => {
    try {
      port.postMessage(message);
    } catch {
      // 页签 Port 已断开（页面导航/窗口关闭先于应答）：静默丢弃
    }
  };

  const releaseRequest = (requestId: string): void => {
    requestPorts.delete(requestId);
    for (const meta of tabs.values()) {
      if (meta.requests.delete(requestId)) break;
    }
  };

  const failAllInFlight = (message: string): void => {
    for (const [requestId, port] of requestPorts) {
      replyToTab(port, {
        type: 'task-error',
        requestId,
        code: 'EXTENSION_HOST_UNAVAILABLE',
        message,
      } satisfies AgentTaskErrorMessage);
      releaseRequest(requestId);
    }
  };

  const forgetTab = (port: chrome.runtime.Port): void => {
    const meta = tabs.get(port);
    if (!meta) return;
    for (const requestId of meta.requests) {
      const mapped = requestPorts.get(requestId);
      if (mapped === port) requestPorts.delete(requestId);
    }
    tabs.delete(port);
  };

  const onTabMessage = (port: chrome.runtime.Port, meta: TabConnection, message: unknown): void => {
    if (!isAgentTaskTabMessage(message)) return;
    // 心跳：到达本身即重置 SW 空闲计时，无需处理
    if (message.type === 'heartbeat') return;
    if (message.type === 'cancel-task') {
      replyToTab(port, {
        type: 'task-error',
        requestId: message.requestId,
        code: 'PROTOCOL_MISMATCH',
        message: 'cancel-task 为 v2 预留能力，本期未实现（终止请在侧栏切换到任务会话后操作）',
      } satisfies AgentTaskErrorMessage);
      return;
    }
    // create-task：白名单闸门（Q5 默认拒绝）→ 宿主可用性 → 注入可信来源转发
    const reject = (code: AgentTaskErrorMessage['code'], reason: string): void => {
      replyToTab(port, {
        type: 'task-error',
        requestId: message.requestId,
        code,
        message: reason,
      } satisfies AgentTaskErrorMessage);
    };
    if (!allowlist.has(meta.origin)) {
      reject('ORIGIN_NOT_ALLOWED', `来源 ${meta.origin} 不在页签反调白名单中（设置页可配置）`);
      return;
    }
    if (hostPort === null) {
      reject('EXTENSION_HOST_UNAVAILABLE', '侧边栏未打开或任务宿主未就绪，无法执行 agent 任务');
      return;
    }
    meta.requests.add(message.requestId);
    requestPorts.set(message.requestId, port);
    const routed: AgentTaskRoutedCreateMessage = {
      type: 'create-task',
      requestId: message.requestId,
      payload: message.payload,
      sender: { tabId: meta.tabId, origin: meta.origin },
    };
    try {
      hostPort.postMessage(routed);
    } catch (error) {
      releaseRequest(message.requestId);
      reject('EXTENSION_HOST_UNAVAILABLE', `任务转发宿主失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const onConnect = (port: chrome.runtime.Port): void => {
    if (port.name === AGENT_TASK_TAB_PORT_NAME) {
      // 可信来源只认 chrome 注入的 Port.sender；缺失（异常连接）直接断开
      const tabId = port.sender?.tab?.id;
      const origin = port.sender?.origin;
      if (typeof tabId !== 'number' || typeof origin !== 'string' || origin.length === 0) {
        consumeRuntimeLastError();
        port.disconnect();
        return;
      }
      const meta: TabConnection = { tabId, origin, requests: new Set() };
      tabs.set(port, meta);
      port.onMessage.addListener((message: unknown) => onTabMessage(port, meta, message));
      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        forgetTab(port);
      });
      return;
    }
    if (port.name === AGENT_TASK_HOST_PORT_NAME) {
      // 后连宿主替换前者：旧宿主视为退场，其在途请求立即补偿
      if (hostPort !== null && hostPort !== port) {
        hostPort.disconnect();
      }
      hostPort = port;
      port.onMessage.addListener((message: unknown) => {
        if (!isAgentTaskHostReplyMessage(message)) return;
        const target = requestPorts.get(message.requestId);
        if (!target) return; // 未知 requestId（SW 重启后旧宿主迟到的应答）：丢弃
        replyToTab(target, message);
        if (message.type !== 'task-ack') releaseRequest(message.requestId);
      });
      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        if (hostPort === port) hostPort = null;
        failAllInFlight('侧边栏任务宿主已断开（侧栏关闭或扩展重载），任务不可达');
      });
    }
  };

  const refreshAllowlist = async (): Promise<void> => {
    const chromeGlobal = (globalThis as {
      chrome?: { storage?: { local?: { get: typeof chrome.storage.local.get } } };
    }).chrome;
    if (!chromeGlobal?.storage?.local) return;
    try {
      const stored = await chromeGlobal.storage.local.get([TAB_INVOKE_ALLOWLIST_KEY]);
      const value = stored[TAB_INVOKE_ALLOWLIST_KEY];
      const next = new Set<string>();
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.length > 0) next.add(item);
        }
      }
      allowlist = next;
    } catch (error) {
      // 读取失败维持旧缓存（首次失败 = 空白名单 = 默认拒绝，安全侧兜底）
      console.error('[WebMCP] 读取页签反调白名单失败:', error);
    }
  };

  const onStorageChange = (
    changes: Record<string, unknown>,
    areaName: string
  ): void => {
    if (areaName !== 'local' || !(TAB_INVOKE_ALLOWLIST_KEY in changes)) return;
    void refreshAllowlist();
  };

  chrome.runtime.onConnect.addListener(onConnect);
  void refreshAllowlist();
  chrome.storage.onChanged.addListener(onStorageChange);

  return {
    stop: () => {
      chrome.runtime.onConnect.removeListener(onConnect);
      chrome.storage.onChanged.removeListener(onStorageChange);
      failAllInFlight('任务路由已停止');
      for (const port of tabs.keys()) port.disconnect();
      tabs.clear();
      hostPort?.disconnect();
      hostPort = null;
    },
  };
}
