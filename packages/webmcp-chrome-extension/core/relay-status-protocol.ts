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
  | { type: 'update'; statuses: RelayTabStatus[] }
  /** 连接建立时的调用日志全量快照（环形缓冲，最近 INVOKE_LOG_CAP 条）。 */
  | { type: 'invoke-logs'; entries: RelayInvokeLogEntry[] }
  /** 单次调用的开始/结束事件（结束事件就地合并进同 callId 条目）。 */
  | { type: 'invoke-log'; phase: RelayInvokeLogPhase; entry: RelayInvokeLogEntry };

/** 侧边栏 → SW 的消息。 */
export type RelayStatusRequest =
  | {
      /** 请求立即重发一次全量快照（重连后对齐用）。 */
      type: 'subscribe';
    }
  | {
      /**
       * 手动重建活动标签页的 SW→页面 Port 连接（「webmcp连接刷新」按钮）：
       * SW 强制销毁该页的 Port + RelaySourceClient 条目后全新重建。
       */
      type: 'webmcp-reconnect';
    }
  | {
      /**
       * 手动重建活动标签页的 SW→relay WebSocket 连接（「relay连接刷新」按钮）：
       * 关闭现有 WebSocket 并重新全范围发现握手，Port 保持不动。
       */
      type: 'relay-reconnect';
    };

// ---- relay 调用日志（侧栏「relay 调用」页只读展示）----

/** 面板侧调用日志环形缓冲上限（SW 与侧栏两侧一致）。 */
export const INVOKE_LOG_CAP = 100;

/** 单条 relay 工具调用日志（SW handleInvoke 采集，侧栏只读展示）。 */
export interface RelayInvokeLogEntry {
  /** relay 下发的调用 ID。 */
  callId: string;
  /** 真实 Chrome tabId（SW 编排层回填）。 */
  tabId: number;
  /** 工具名（页面原始名）。 */
  toolName: string;
  /** 调用开始时间（Date.now()）。 */
  startedAt: number;
  /** 入参摘要（截断）。 */
  argsSummary: string;
  /** 结束阶段才有：耗时 ms。 */
  elapsedMs?: number;
  /** 结束阶段才有：true 成功 / false 失败；缺省 = 仍在执行。 */
  ok?: boolean;
  /** 结束阶段才有：结果摘要（成功）或错误文本（失败，截断）。 */
  resultSummary?: string;
}

/** 调用日志事件阶段。 */
export type RelayInvokeLogPhase = 'started' | 'finished';

/**
 * 把一次调用日志事件应用到缓冲（started 追加、finished 就地合并）。
 * SW 侧采集与侧栏侧接收共用同一份合并语义，避免两侧状态漂移。
 * 返回新数组（不可变更新，便于 Vue/React 直接替换引用）。
 */
export function applyInvokeLogEvent(
  buffer: readonly RelayInvokeLogEntry[],
  phase: RelayInvokeLogPhase,
  entry: RelayInvokeLogEntry
): RelayInvokeLogEntry[] {
  if (phase === 'started') {
    const next = [...buffer, { ...entry }];
    return next.length > INVOKE_LOG_CAP ? next.slice(next.length - INVOKE_LOG_CAP) : next;
  }
  // finished：从后往前找同 callId 且尚未结束的条目就地合并（找不到则丢弃，缓冲可能已被裁剪）
  const index = [...buffer]
    .reverse()
    .findIndex((item) => item.callId === entry.callId && item.ok === undefined);
  if (index === -1) {
    return [...buffer];
  }
  const target = buffer.length - 1 - index;
  const merged = [...buffer];
  const prev = merged[target];
  if (!prev) {
    return [...buffer];
  }
  // 显式构造而非展开：exactOptionalPropertyTypes 下展开会把可选属性弱化为可缺省
  const next: RelayInvokeLogEntry = {
    callId: prev.callId,
    tabId: prev.tabId,
    toolName: prev.toolName,
    startedAt: prev.startedAt,
    argsSummary: prev.argsSummary,
  };
  if (prev.elapsedMs !== undefined) next.elapsedMs = prev.elapsedMs;
  if (prev.ok !== undefined) next.ok = prev.ok;
  if (prev.resultSummary !== undefined) next.resultSummary = prev.resultSummary;
  if (entry.elapsedMs !== undefined) next.elapsedMs = entry.elapsedMs;
  if (entry.ok !== undefined) next.ok = entry.ok;
  if (entry.resultSummary !== undefined) next.resultSummary = entry.resultSummary;
  merged[target] = next;
  return merged;
}
