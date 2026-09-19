// 宿主关闭通知的 CS 汇合层（C7 增强路径，探索文档 §5.2 / propose P6）。
//
// 职责：把两条通知路径汇合为一次页面侧断连推送 ——
// 1. 主路径：SW 广播 webmcp-host-status（chrome.tabs.sendMessage 直达本页）；
// 2. 增强路径：SW 休眠/重启漏发广播时，由 page-tools-bridge 的 onAllPortsDisconnected
//    触发自检（500ms 延迟 → host-status-query → SW 以 SIDE_PANEL context 判存活）。
//
// 汇合语义：
// - 2s 去重：两路通知几乎同时到达时只推送一次（页面无需感知重复事件）；
// - Q3 预检：推送前 listTools 确认页面注册了 web_mcp_agent_disconnect，
//   未注册（页面未开启智能体反调）则跳过 —— 广播是全页签的，工具是否存在是页面自决；
// - 推送：callTool web_mcp_agent_disconnect，入参 = buildAgentDisconnectPayload()
//   （与 C6 初始化载荷同构的事件信封：version + occurredAt）。
// 失败语义：预检/调用失败仅记日志（页面已死时推送必然失败，属正常竞态）。
import type { Client } from '@modelcontextprotocol/client';
import {
  AGENT_DISCONNECT_TOOL_NAME,
  buildAgentDisconnectPayload,
} from 'webmcp-agent-chat-core';
import {
  isAgentHostStatusBroadcast,
  isAgentHostStatusReply,
  type AgentHostStatusQuery,
} from './agent-task-protocol';

/** 自检延迟（ms）：等页面刷新/面板快速重连的抖动过去后再查询。 */
const SELF_CHECK_DELAY_MS = 500;
/** 去重窗口（ms）：窗口内的重复通知只推送一次。 */
const DEDUPE_WINDOW_MS = 2_000;

/** 宿主状态 relay 依赖（缝函数，便于单测替换）。 */
export interface HostStatusRelayDeps {
  /** 页面 MCP Client（或握手 Promise）：Q3 预检与断连推送经此执行。 */
  client: Client | Promise<Client>;
  /** 日志缝（CS 侧为 console 包装；缺省静默）。 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 时钟缝（单测）。 */
  now?: () => number;
}

/** 汇合句柄：notePanelPortsClosed 由 page-tools-bridge 回调触发；dispose 移除监听。 */
export interface HostStatusRelayHandle {
  /** PAGE_TOOLS Port 全断回调入口（增强路径触发源）。 */
  notePanelPortsClosed(): void;
  /** 移除 chrome.runtime.onMessage 监听并取消挂起的自检定时器。 */
  dispose(): void;
}

/**
 * 创建宿主状态 relay。同步注册 chrome.runtime.onMessage 监听（广播不依赖
 * MCP 握手完成；预检/推送会等待 clientPromise 落定）。
 */
export function createHostStatusRelay(deps: HostStatusRelayDeps): HostStatusRelayHandle {
  const now = deps.now ?? Date.now;
  const log = deps.onLog ?? (() => {});
  let lastHandledAt = -Infinity;
  let selfCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  /** 汇合逻辑：去重 → Q3 预检 → 断连推送。source 仅用于日志定位。 */
  const handleHostUnavailable = async (source: 'broadcast' | 'self-check'): Promise<void> => {
    const at = now();
    if (at - lastHandledAt < DEDUPE_WINDOW_MS) {
      log('info', `[WebMCP] host-unavailable 通知去重（source=${source}，窗口 ${DEDUPE_WINDOW_MS}ms）`);
      return;
    }
    lastHandledAt = at;
    try {
      const client = await deps.client;
      const { tools } = await client.listTools();
      // Q3 预检：页面未注册断连工具 = 未开启智能体反调，无需通知
      if (!tools.some((tool) => tool.name === AGENT_DISCONNECT_TOOL_NAME)) {
        log('info', `[WebMCP] 页面未注册 ${AGENT_DISCONNECT_TOOL_NAME}，跳过宿主关闭通知（source=${source}）`);
        return;
      }
      await client.callTool({
        name: AGENT_DISCONNECT_TOOL_NAME,
        // MCP callTool arguments 要求 index signature（载荷是 plain object，转换安全）
        arguments: buildAgentDisconnectPayload() as unknown as Record<string, unknown>,
      });
      log('info', `[WebMCP] 宿主关闭通知已推送（source=${source}）`);
    } catch (error) {
      log('warn', `[WebMCP] 宿主关闭通知推送失败（source=${source}）: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const onRuntimeMessage = (message: unknown): void => {
    if (!isAgentHostStatusBroadcast(message)) return;
    // 不返回 true：广播无需应答，保持消息通道默认关闭以免阻塞其他监听器
    void handleHostUnavailable('broadcast');
  };

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  const runSelfCheck = (): void => {
    if (disposed) return;
    const query: AgentHostStatusQuery = { type: 'host-status-query' };
    chrome.runtime.sendMessage(query, (response: unknown) => {
      // 消费 lastError（SW 不存在/无接收者）；探测异常从严 hostAlive=true，宁可漏报不误报
      void chrome.runtime.lastError;
      if (isAgentHostStatusReply(response) && !response.hostAlive) {
        void handleHostUnavailable('self-check');
      }
    });
  };

  return {
    notePanelPortsClosed: () => {
      if (disposed) return;
      if (selfCheckTimer !== null) clearTimeout(selfCheckTimer);
      selfCheckTimer = setTimeout(() => {
        selfCheckTimer = null;
        runSelfCheck();
      }, SELF_CHECK_DELAY_MS);
    },
    dispose: () => {
      disposed = true;
      if (selfCheckTimer !== null) {
        clearTimeout(selfCheckTimer);
        selfCheckTimer = null;
      }
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    },
  };
}
