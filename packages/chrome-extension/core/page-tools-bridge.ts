// 页面工具桥接：把隔离世界内已连接的 MCP Client 以长连接（chrome.runtime.Port）
// 暴露给扩展的其他上下文（当前为侧边栏页面）。
//
// 设计说明：
// - 复述方案中提到的 ExtensionServer/ClientTransport 需要 @modelcontextprotocol/server
//   的 MCP Server 实例才能挂载；为避免为本扩展内部通信额外引入服务端 SDK，
//   改用同一传输介质（chrome.runtime Port）上的轻量请求/响应协议，
//   协议方法名与 MCP 语义对齐（listTools / callTool）。
// - 该协议仅存在于本扩展内部（侧边栏 ↔ content script），不触及
//   html-app 的工具契约，页面工具的 schema 原样透传，不做二次包装。
import type { Client } from '@modelcontextprotocol/client';

/** 桥接端口名，侧边栏与 content script 双方约定。 */
export const PAGE_TOOLS_PORT_NAME = 'webmcp-page-tools';

/** 侧边栏 → content script 的请求消息。 */
export interface PageToolsRequest {
  /** 请求 id，用于匹配响应（同一 Port 上并发请求）。 */
  id: number;
  type: 'listTools' | 'callTool';
  /** type 为 callTool 时必填。 */
  name?: string;
  /** type 为 callTool 时的入参对象。 */
  args?: Record<string, unknown>;
}

/** content script → 侧边栏的响应消息。 */
export interface PageToolsResponse {
  id: number;
  ok: boolean;
  /** ok 为 true 时：listTools 返回工具元数据数组，callTool 返回执行结果（原样透传）。 */
  result?: unknown;
  /** ok 为 false 时的错误信息。 */
  error?: string;
}

/** content script → 侧边栏的单向通知（无 id，区别于请求响应）。 */
export interface PageToolsNotification {
  type: 'toolsChanged';
}

/** 桥接句柄：停止桥接，以及在页面工具清单变化时广播通知。 */
export interface PageToolsBridgeHandle {
  /** 停止桥接：移除监听器并断开所有活跃端口（content script 卸载时调用）。 */
  stop(): void;
  /** 向所有活跃端口广播 toolsChanged 通知（侧栏收到后刷新清单）。 */
  notifyToolsChanged(): void;
}

/** 桥接透传的工具元数据（来自 MCP listTools，schema 原样保留）。 */
export interface PageToolMeta {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** 判定未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从 MCP callTool 结果中提取可读文本：拼接 text 内容块，其他形态回退为 JSON。 */
export function serializeToolResult(result: unknown): string {
  if (!isRecord(result)) {
    return JSON.stringify(result) ?? 'null';
  }
  const content = result['content'];
  if (Array.isArray(content)) {
    const texts = content
      .map((block) =>
        isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
          ? block['text']
          : undefined
      )
      .filter((text): text is string => text !== undefined);
    if (texts.length > 0) return texts.join('\n');
  }
  return JSON.stringify(result);
}

/**
 * 启动页面工具桥接：监听扩展内长连接，把 listTools / callTool 代理到给定 MCP Client。
 *
 * @param client 已连接到当前页面的 MCP Client（core/content-script.ts 产出）
 * @returns 桥接句柄：stop() 停止桥接；notifyToolsChanged() 在页面工具清单
 *          变化（MCP listChanged）时向侧栏广播，弥补纯请求-响应协议无推送的缺口
 */
export function startPageToolsBridge(client: Client): PageToolsBridgeHandle {
  const ports = new Set<chrome.runtime.Port>();

  const notifyToolsChanged = (): void => {
    const notification: PageToolsNotification = { type: 'toolsChanged' };
    for (const port of ports) {
      try {
        port.postMessage(notification);
      } catch {
        // 端口可能已断开（onDisconnect 会清理），跳过即可
      }
    }
  };

  const onMessage = (port: chrome.runtime.Port, message: unknown): void => {
    if (
      !isRecord(message) ||
      typeof message['id'] !== 'number' ||
      (message['type'] !== 'listTools' && message['type'] !== 'callTool')
    ) {
      return;
    }
    const request = message as unknown as PageToolsRequest;

    const respond = (response: PageToolsResponse): void => {
      port.postMessage(response);
    };

    if (request.type === 'listTools') {
      client
        .listTools()
        .then(({ tools }) =>
          respond({
            id: request.id,
            ok: true,
            result: tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? '',
              inputSchema: tool.inputSchema,
            })),
          })
        )
        .catch((error: unknown) =>
          respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
        );
      return;
    }

    // callTool：name 必填，args 允许缺省为空对象
    if (typeof request.name !== 'string') {
      respond({ id: request.id, ok: false, error: 'callTool 缺少 name 参数' });
      return;
    }
    client
      .callTool({ name: request.name, arguments: request.args ?? {} })
      .then((result) => respond({ id: request.id, ok: true, result }))
      .catch((error: unknown) =>
        respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
      );
  };

  const onConnect = (port: chrome.runtime.Port): void => {
    if (port.name !== PAGE_TOOLS_PORT_NAME) return;
    ports.add(port);
    port.onMessage.addListener((message: unknown) => onMessage(port, message));
    port.onDisconnect.addListener(() => {
      ports.delete(port);
    });
  };

  chrome.runtime.onConnect.addListener(onConnect);

  return {
    stop: () => {
      chrome.runtime.onConnect.removeListener(onConnect);
      for (const port of ports) port.disconnect();
      ports.clear();
    },
    notifyToolsChanged,
  };
}
