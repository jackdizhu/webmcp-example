// Tab 反调通道的 content script 侧桥接（C5 反向通道第 2 跳）。
//
// 职责：把 MAIN world SDK 的 window.postMessage 请求转发到 SW 路由
// （AGENT_TASK_TAB_PORT_NAME 长连接），把 SW/宿主的应答回投给页面；
// 任务在途期间每 20s 发心跳维持 SW 不被空闲回收（AGENT_TASK_HEARTBEAT_INTERVAL_MS）。
//
// 信任边界：本层不校验业务语义（页面不可信，校验在 SW/宿主）；
// 仅做结构过滤（isAgentTaskTabMessage）防止任意窗口消息灌入通道。
//
// 生命周期：Port 断开（SW 休眠/重载）时在途请求统一补发 task-error
// （EXTENSION_HOST_UNAVAILABLE），不悬挂页面 Promise；下次请求懒重连。
// 心跳只在有在途任务时运行 —— 平时零流量，不阻挠 SW 休眠。
// C6：init-request 与 create-task 同路（pending + 心跳），应答侧零改动。
// F5 孤儿修复（C7 Q6）：扩展 reload 后旧 CS 的 runtime.connect 同步抛
// "Extension context invalidated" —— 包 try/catch，孤儿自摘除 window 监听
// （防与新注入桥接双应答）并 failPending 落定全部在途 Promise（防悬挂）。
import {
  AGENT_TASK_HEARTBEAT_INTERVAL_MS,
  AGENT_TASK_TAB_PORT_NAME,
  isAgentTaskHostReplyMessage,
  isAgentTaskTabMessage,
  type AgentTaskErrorMessage,
} from './agent-task-protocol';

/** 页面 → CS 的 window.postMessage 来源标记（与 shell/agent-task-sdk.ts 约定一致）。 */
const SDK_SOURCE = 'webmcp-agent-task-sdk';
/** CS → 页面的 window.postMessage 来源标记。 */
const BRIDGE_SOURCE = 'webmcp-agent-task-bridge';

/** 消费 chrome.runtime.lastError，避免 Unchecked runtime.lastError 告警（同 panel-client 口径）。 */
function consumeRuntimeLastError(): void {
  const chromeGlobal = (globalThis as {
    chrome?: { runtime?: { lastError?: { message?: string } } };
  }).chrome;
  void chromeGlobal?.runtime?.lastError?.message;
}

/**
 * 启动 CS 侧反调桥接（content script 加载时调用一次；与页面工具桥接并列、互不依赖）。
 *
 * @returns 停止句柄：移除 window 监听、清空心跳、断开 SW Port（测试/卸载用）
 */
export function startAgentTaskTabBridge(): { stop(): void } {
  /** SW 长连接（懒建连：首个任务请求时建立）。 */
  let port: chrome.runtime.Port | null = null;
  /** 在途任务 requestId 集合（心跳开关与失联补偿的依据）。 */
  const pending = new Set<string>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const postToPage = (message: unknown): void => {
    try {
      window.postMessage({ ...(message as Record<string, unknown>), source: BRIDGE_SOURCE }, '*');
    } catch {
      // 页面正在导航/卸载时 postMessage 可能抛错；请求随页面消亡，静默丢弃
    }
  };

  const failPending = (code: AgentTaskErrorMessage['code'], message: string): void => {
    for (const requestId of pending) {
      postToPage({ type: 'task-error', requestId, code, message } satisfies AgentTaskErrorMessage);
    }
    pending.clear();
    stopHeartbeat();
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const ensureHeartbeat = (): void => {
    if (heartbeatTimer !== null || pending.size === 0) return;
    heartbeatTimer = setInterval(() => {
      if (port === null) return;
      try {
        port.postMessage({ type: 'heartbeat', ts: Date.now() });
      } catch {
        // 端口已断开：onDisconnect 会触发失联补偿，此处静默
      }
    }, AGENT_TASK_HEARTBEAT_INTERVAL_MS);
  };

  const connectPort = (): chrome.runtime.Port | null => {
    if (port !== null) return port;
    const chromeGlobal = (globalThis as { chrome?: { runtime?: { connect: typeof chrome.runtime.connect } } }).chrome;
    if (!chromeGlobal?.runtime) return null;
    let fresh: chrome.runtime.Port;
    try {
      fresh = chromeGlobal.runtime.connect({ name: AGENT_TASK_TAB_PORT_NAME });
    } catch (error) {
      // F5 孤儿修复：扩展 reload 后旧 CS 上下文已死，connect 同步抛 invalidated。
      // 异常若从消息监听逃逸 → 请求无应答 + SDK Promise 永久悬挂；新旧桥接并存还会双应答。
      if (error instanceof Error && /extension context invalidated/i.test(error.message)) {
        // 本桥接退场：摘除 window 监听（后续请求不再经此转发，由新注入桥接接管）
        window.removeEventListener('message', onWindowMessage);
        failPending('EXTENSION_HOST_UNAVAILABLE', '扩展已重载，任务通道失效（刷新页面后恢复）');
      }
      return null; // 上层 active === null 兜底回 task-error 落定当前请求
    }
    fresh.onMessage.addListener((message: unknown) => {
      if (!isAgentTaskHostReplyMessage(message)) return;
      if (message.type !== 'task-ack') {
        // 终态应答：在途请求落定（ack 仅受理回执，保持在途）
        pending.delete(message.requestId);
        if (pending.size === 0) stopHeartbeat();
      }
      postToPage(message);
    });
    fresh.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      port = null;
      // SW 休眠/重载/扩展 reload：在途请求统一补偿，页面 Promise 不悬挂
      failPending('EXTENSION_HOST_UNAVAILABLE', '扩展任务路由不可用（service worker 已断开），请稍后重试');
    });
    port = fresh;
    return fresh;
  };

  const onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const record = data as Record<string, unknown>;
    if (record['source'] !== SDK_SOURCE) return;
    // 结构守卫只认 type + requestId；source 标记为 SDK 附加字段，宽容放行
    if (!isAgentTaskTabMessage(data)) return;
    if (data.type === 'heartbeat') return; // 心跳由本层生成，页面伪造无意义
    if (data.type === 'create-task' || data.type === 'init-request') {
      // 拉取与任务同路（C6 F4）：入 pending（失联补偿自动覆盖）+ 心跳维持 SW 在线
      pending.add(data.requestId);
      ensureHeartbeat();
    }
    const active = connectPort();
    if (active === null) {
      pending.delete(data.requestId);
      stopHeartbeat();
      postToPage({
        type: 'task-error',
        requestId: data.requestId,
        code: 'EXTENSION_HOST_UNAVAILABLE',
        message: '扩展运行时不可用（chrome.runtime 缺失）',
      } satisfies AgentTaskErrorMessage);
      return;
    }
    try {
      // 转发去掉 source 标记（通道内消息为纯协议线消息）
      const { source: _source, ...wire } = data as unknown as Record<string, unknown> & { source?: unknown };
      void _source;
      active.postMessage(wire);
    } catch (error) {
      pending.delete(data.requestId);
      stopHeartbeat();
      postToPage({
        type: 'task-error',
        requestId: data.requestId,
        code: 'PROTOCOL_MISMATCH',
        message: `任务请求转发失败：${error instanceof Error ? error.message : String(error)}`,
      } satisfies AgentTaskErrorMessage);
    }
  };

  window.addEventListener('message', onWindowMessage);

  return {
    stop: () => {
      window.removeEventListener('message', onWindowMessage);
      stopHeartbeat();
      failPending('EXTENSION_HOST_UNAVAILABLE', '任务桥接已停止');
      port?.disconnect();
      port = null;
    },
  };
}
