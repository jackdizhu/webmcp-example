// relay-status-store 单测：stub RelayStatusClient + onLog 收集器，覆盖状态 diff 日志、
// 调用计数、终止复位、选择回调与 dispose 语义。不触 chrome.*，不触默认 logger。
import { describe, expect, it, vi } from 'vitest';
import type {
  RelayInvokeLogEntry,
  RelayTabSelection,
  RelayTabStatus,
} from '../../core/relay-status-protocol';
import type { RelayStatusClient } from './relay-status-client';
import { createRelayStatusStore } from './relay-status-store';

interface ClientStub {
  client: RelayStatusClient;
  updateListeners: Set<(statuses: RelayTabStatus[]) => void>;
  invokeListeners: Set<(entries: RelayInvokeLogEntry[]) => void>;
  selectionListeners: Set<(selection: RelayTabSelection) => void>;
  requests: Array<{ type: string; tabIds?: number[] }>;
  emitUpdate: (statuses: RelayTabStatus[]) => void;
  emitInvokeLogs: (entries: RelayInvokeLogEntry[]) => void;
  emitSelection: (selection: RelayTabSelection) => void;
}

function createClientStub(): ClientStub {
  const updateListeners = new Set<(statuses: RelayTabStatus[]) => void>();
  const invokeListeners = new Set<(entries: RelayInvokeLogEntry[]) => void>();
  const selectionListeners = new Set<(selection: RelayTabSelection) => void>();
  const requests: Array<{ type: string; tabIds?: number[] }> = [];
  const client: RelayStatusClient = {
    getStatuses: () => [],
    onUpdate(listener) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    getInvokeLogs: () => [],
    onInvokeLogs(listener) {
      invokeListeners.add(listener);
      return () => invokeListeners.delete(listener);
    },
    getSelection: () => ({ tabIds: [] }),
    onSelectionChange(listener) {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    sendRequest: (request) => {
      const captured: { type: string; tabIds?: number[] } = { type: request.type };
      if (request.type === 'set-selection') {
        captured['tabIds'] = (request as { tabIds: number[] }).tabIds;
      }
      requests.push(captured);
    },
    disconnect: () => {},
  };
  return {
    client,
    updateListeners,
    invokeListeners,
    selectionListeners,
    requests,
    emitUpdate: (statuses) => updateListeners.forEach((listener) => listener(statuses)),
    emitInvokeLogs: (entries) => invokeListeners.forEach((listener) => listener(entries)),
    emitSelection: (selection) => selectionListeners.forEach((listener) => listener(selection)),
  };
}

function status(tabId: number, state: string, detail?: string): RelayTabStatus {
  return { tabId, state, ...(detail !== undefined ? { detail } : {}), selected: false } as RelayTabStatus;
}

function describeLogs(logs: Array<{ source: string; event: string; payload: unknown }>): string[] {
  return logs
    .filter((entry) => entry.event === 'relay_status')
    .map((entry) => String(entry.payload));
}

describe('createRelayStatusStore', () => {
  it('bind 后推送状态快照：statuses 更新且逐页签首次登记写迁移日志', () => {
    const stub = createClientStub();
    const logs: Array<{ source: string; event: string; payload: unknown }> = [];
    const store = createRelayStatusStore({
      onLog: (_level, source, event, payload) => {
        logs.push({ source, event, payload });
      },
    });

    store.bind(stub.client);
    stub.emitUpdate([status(1, 'connected'), status(2, 'stopped')]);

    expect(store.statuses.value).toHaveLength(2);
    expect(store.statuses.value[0]?.tabId).toBe(1);
    expect(describeLogs(logs)).toEqual(['tab 1 → connected', 'tab 2 → stopped']);
    store.dispose();
  });

  it('状态迁移与页签移除：变化才写日志，移除写 removed 并清理缓存', () => {
    const stub = createClientStub();
    const logs: Array<{ source: string; event: string; payload: unknown }> = [];
    const store = createRelayStatusStore({ onLog: (_l, s, e, p) => logs.push({ source: s, event: e, payload: p }) });
    store.bind(stub.client);

    stub.emitUpdate([status(1, 'connecting'), status(2, 'connected')]);
    const afterFirst = describeLogs(logs).length;
    // 状态未变化：不产生新日志
    stub.emitUpdate([status(1, 'connecting'), status(2, 'connected')]);
    expect(describeLogs(logs).length).toBe(afterFirst);
    // tab1 迁移 + tab2 消失
    stub.emitUpdate([status(1, 'connected')]);
    expect(describeLogs(logs).slice(afterFirst)).toEqual(['tab 1 → connected', 'tab 2 → removed']);
    store.dispose();
  });

  it('调用日志与执行计数：ok 缺省计执行中；终止后归零自动复位', async () => {
    const stub = createClientStub();
    const store = createRelayStatusStore();
    store.bind(stub.client);

    const entry = (callId: string, ok?: boolean): RelayInvokeLogEntry =>
      ({ callId, startedAt: 0, toolName: 't', argsSummary: '', ...(ok !== undefined ? { ok } : {}) }) as RelayInvokeLogEntry;
    stub.emitInvokeLogs([entry('a'), entry('b', true)]);
    expect(store.runningCount.value).toBe(1);

    store.terminateWait();
    expect(store.terminated.value).toBe(true);

    stub.emitInvokeLogs([entry('a', false), entry('b', true)]);
    expect(store.runningCount.value).toBe(0);
    // runningCount 归零触发 watch 复位（waitFor 轮询对调度时序健壮；watch 失效则超时失败）
    await vi.waitFor(() => {
      expect(store.terminated.value).toBe(false);
    });
    store.dispose();
  });

  it('数据源选择推送：selection 更新并触发 onSelectionChanged 钩子', () => {
    const stub = createClientStub();
    const selections: RelayTabSelection[] = [];
    const store = createRelayStatusStore();
    store.bind(stub.client, {
      onSelectionChanged: (selection) => selections.push(selection),
    });

    // 订阅即触发一次（stub 的 emit 由测试显式驱动；客户端实现为订阅即推）
    stub.emitSelection({ tabIds: [7, 8] });
    expect(store.selection.value).toEqual({ tabIds: [7, 8] });
    expect(selections).toEqual([{ tabIds: [7, 8] }]);
    store.dispose();
  });

  it('requestResetSelection 转发 reset-selection；bind 前调用静默跳过', () => {
    const stub = createClientStub();
    const store = createRelayStatusStore();

    expect(() => store.requestResetSelection()).not.toThrow();
    store.bind(stub.client);
    store.requestResetSelection();
    expect(stub.requests).toEqual([{ type: 'reset-selection' }]);
    store.dispose();
  });

  it('dispose 后解除订阅：后续推送不再落入 store', () => {
    const stub = createClientStub();
    const store = createRelayStatusStore();
    store.bind(stub.client);
    store.dispose();

    stub.emitUpdate([status(1, 'connected')]);
    stub.emitInvokeLogs([]);
    stub.emitSelection({ tabIds: [1] });
    expect(store.statuses.value).toEqual([]);
    expect(store.selection.value).toEqual({ tabIds: [] });
  });

  it('重复 bind：旧订阅被顶替（dispose 未调用时 rebind 安全）', () => {
    const first = createClientStub();
    const second = createClientStub();
    const store = createRelayStatusStore();
    store.bind(first.client);
    store.bind(second.client);

    first.emitUpdate([status(1, 'connected')]);
    expect(store.statuses.value).toEqual([]);

    second.emitUpdate([status(2, 'connected')]);
    expect(store.statuses.value).toHaveLength(1);
    store.dispose();
  });
});
