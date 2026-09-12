// relay-status-client 单测：状态快照 + 调用日志（invoke-logs 全量对齐 / invoke-log 增量合并）
// + 标签页数据源选择（selection 推送）。
import { describe, expect, it, vi } from 'vitest';

import type { RelayInvokeLogEntry, RelayStatusMessage } from '../../core/relay-status-protocol';
import { connectRelayStatus } from './relay-status-client';

/** 状态端口桩：服务端（SW）视角可 postMessage / emit。 */
class FakePort {
  sent: unknown[] = [];
  private messageListeners = new Set<(message: unknown) => void>();
  private disconnectListeners = new Set<() => void>();

  readonly onMessage = {
    addListener: (cb: (message: unknown) => void) => this.messageListeners.add(cb),
    removeListener: (cb: (message: unknown) => void) => this.messageListeners.delete(cb),
  };
  readonly onDisconnect = {
    addListener: (cb: () => void) => this.disconnectListeners.add(cb),
    removeListener: (cb: () => void) => this.disconnectListeners.delete(cb),
  };

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  disconnect(): void {
    for (const listener of [...this.disconnectListeners]) {
      listener();
    }
  }

  /** 模拟 SW → 侧边栏推送。 */
  emit(message: RelayStatusMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }
}

function createEntry(callId: string, overrides: Partial<RelayInvokeLogEntry> = {}): RelayInvokeLogEntry {
  return {
    callId,
    tabId: 42,
    toolName: 'get_status',
    startedAt: 1000,
    argsSummary: '{}',
    ...overrides,
  };
}

describe('connectRelayStatus 调用日志', () => {
  it('连接后以 invoke-logs 快照对齐缓冲并通知监听器', () => {
    const port = new FakePort();
    const client = connectRelayStatus(() => port as unknown as chrome.runtime.Port);
    const seen: number[] = [];
    client.onInvokeLogs((entries) => seen.push(entries.length));

    port.emit({ type: 'invoke-logs', entries: [createEntry('c-1'), createEntry('c-2')] });

    expect(client.getInvokeLogs()).toHaveLength(2);
    expect(seen).toEqual([0, 2]); // 订阅时立即通知一次（空缓冲），快照后再通知
    client.disconnect();
  });

  it('invoke-log 增量：started 追加、finished 就地合并', () => {
    const port = new FakePort();
    const client = connectRelayStatus(() => port as unknown as chrome.runtime.Port);
    const listener = vi.fn();
    client.onInvokeLogs(listener);

    port.emit({
      type: 'invoke-log',
      phase: 'started',
      entry: createEntry('c-1') as never,
    });
    port.emit({
      type: 'invoke-log',
      phase: 'finished',
      entry: createEntry('c-1', { ok: true, elapsedMs: 30, resultSummary: '{"s":1}' }) as never,
    });

    const logs = client.getInvokeLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ callId: 'c-1', ok: true, elapsedMs: 30 });
    // 订阅时初始通知 + started + finished
    expect(listener).toHaveBeenCalledTimes(3);
    client.disconnect();
  });

  it('未知消息类型与畸形负载静默忽略', () => {
    const port = new FakePort();
    const client = connectRelayStatus(() => port as unknown as chrome.runtime.Port);
    const listener = vi.fn();
    client.onInvokeLogs(listener);

    port.emit({ type: 'invoke-logs' } as never);
    port.emit({ type: 'invoke-log' } as never);
    port.emit({ type: 'nonsense' } as never);

    expect(client.getInvokeLogs()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1); // 仅订阅时的初始通知
    client.disconnect();
  });
});

describe('connectRelayStatus 标签页数据源选择', () => {
  it('selection 消息更新快照并通知监听器（订阅即收到当前值）', () => {
    const port = new FakePort();
    const client = connectRelayStatus(() => port as unknown as chrome.runtime.Port);
    const seen: Array<{ tabIds: number[] }> = [];
    client.onSelectionChange((selection) => seen.push(selection));

    port.emit({ type: 'selection', tabIds: [3, 5] });

    expect(client.getSelection()).toEqual({ tabIds: [3, 5] });
    expect(seen).toEqual([
      { tabIds: [] }, // 订阅时的初始通知（默认空集）
      { tabIds: [3, 5] },
    ]);
    client.disconnect();
  });

  it('畸形 selection 消息忽略，保持上一份快照；set-selection/reset-selection 请求经 sendRequest 发出', () => {
    const port = new FakePort();
    const client = connectRelayStatus(() => port as unknown as chrome.runtime.Port);
    const listener = vi.fn();
    client.onSelectionChange(listener);

    port.emit({ type: 'selection', tabIds: 'oops' } as never);
    port.emit({ type: 'selection', tabIds: [1] });

    expect(client.getSelection()).toEqual({ tabIds: [1] });
    expect(listener).toHaveBeenCalledTimes(2);

    client.sendRequest({ type: 'set-selection', tabIds: [1, 2] });
    client.sendRequest({ type: 'reset-selection' });
    expect(port.sent).toEqual([
      { type: 'set-selection', tabIds: [1, 2] },
      { type: 'reset-selection' },
    ]);
    client.disconnect();
  });
});
