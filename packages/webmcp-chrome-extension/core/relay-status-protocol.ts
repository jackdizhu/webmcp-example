// relay 连接状态展示协议：SW（编排层）与侧边栏之间的运行时 Port 消息契约。
//
// 通道方向：侧边栏（扩展页面）→ chrome.runtime.connect → SW（runtime.onConnect）。
// 与 page-tools 桥接（tabs.connect 到 content script）方向相反，故用独立的 Port 名。
// SW 侧实现见 tab-source-manager.ts 的 startRelayStatusPort。

import type { RelayConnectionStatus } from './relay-source-client';

/** 状态展示专用 Port 名（侧边栏 connect 与 SW onConnect 双方约定）。 */
export const RELAY_STATUS_PORT_NAME = 'webmcp-relay-status';

/** 单个标签页的 relay 连接状态（连接状态 + 展示用元数据）。 */
export interface RelayTabStatus extends RelayConnectionStatus {
  /** 真实 Chrome tabId。 */
  tabId: number;
  /** 页面 URL（可随导航变化，取建立/最近同步时的值）。 */
  url?: string;
  /** 页面标题。 */
  title?: string;
}

/** 状态 Port 上的消息（SW → 侧边栏）。 */
export type RelayStatusMessage =
  /** 连接建立或侧边栏主动请求时的全量快照。 */
  | { type: 'snapshot'; statuses: RelayTabStatus[] }
  /** 任一标签页状态变化后的全量快照（数据量小，全量推送简化客户端去重）。 */
  | { type: 'update'; statuses: RelayTabStatus[] };

/** 侧边栏 → SW 的消息。 */
export type RelayStatusRequest = {
  /** 请求立即重发一次全量快照（重连后对齐用）。 */
  type: 'subscribe';
};
