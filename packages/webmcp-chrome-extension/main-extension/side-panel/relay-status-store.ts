// relay 状态 store（非 UI 可单测，B2 归拢：原 App 层 relay 消费逻辑下沉）。
//
// 职责：订阅 RelayStatusClient 三路推送（状态快照 / 调用日志 / 数据源选择），维护
// reactive 状态 + 逐页签状态迁移 diff 日志 + 执行计数与「已终止等待」复位语义。
// App 保留实例创建、生命周期接线（bind/dispose）与 props 分发；本模块不做任何
// chrome.* 调用——与 SW 的交互全部经注入的 RelayStatusClient。
//
// 日志经 options.onLog 注入（缺省 logEvent），与共享库同款解耦手法，便于单测收集。
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { logEvent } from './logger';
import type {
  RelayInvokeLogEntry,
  RelayTabSelection,
  RelayTabStatus,
} from '../../core/relay-status-protocol';
import type { RelayStatusClient } from './relay-status-client';

type LogFn = typeof logEvent;

export interface RelayStatusStoreOptions {
  /** 日志落点注入（缺省 logEvent；测试注入收集器）。 */
  onLog?: LogFn;
}

/** 数据源选择变化钩子：App 据此同步 pageTools.setTargetTabs 并刷新工具清单。 */
export interface RelayStatusStoreHooks {
  onSelectionChanged?: (selection: RelayTabSelection) => void;
}

export interface RelayStatusStore {
  /** 各标签页连接状态快照（SW 推送；含未选中页签的 stopped 占位）。 */
  readonly statuses: Ref<RelayTabStatus[]>;
  /** 全局标签页数据源选择（SW 推送；默认 = 打开侧栏时的活动页签）。 */
  readonly selection: Ref<RelayTabSelection>;
  /** relay 调用日志（环形缓冲，时间正序）。 */
  readonly invokeLogs: Ref<RelayInvokeLogEntry[]>;
  /** 执行中的调用数（ok 缺省 = 仍在执行）。 */
  readonly runningCount: ComputedRef<number>;
  /** 用户已对 relay 调用点「终止」：执行锁立即解除；归零后自动复位。 */
  readonly terminated: Ref<boolean>;
  /** 绑定客户端并建立三路订阅（onUpdate/onInvokeLogs/onSelectionChange）。 */
  bind(client: RelayStatusClient, hooks?: RelayStatusStoreHooks): void;
  /** 发送 reset-selection（侧栏打开即重置为当前活动页签，Q5 全局初始化语义）。 */
  requestResetSelection(): void;
  /** 用户点「终止」：停止等待 relay 调用（后台调用仍会完成并落入日志）。 */
  terminateWait(): void;
  /** 解除全部订阅（客户端 disconnect 仍由宿主负责）。 */
  dispose(): void;
}

export function createRelayStatusStore(options: RelayStatusStoreOptions = {}): RelayStatusStore {
  const onLog = options.onLog ?? logEvent;

  const statuses = ref<RelayTabStatus[]>([]);
  const selection = ref<RelayTabSelection>({ tabIds: [] });
  const invokeLogs = ref<RelayInvokeLogEntry[]>([]);
  const terminated = ref(false);
  const runningCount = computed(() =>
    invokeLogs.value.filter((entry) => entry.ok === undefined).length
  );

  // 用户终止后执行锁立即解除；全部调用结束（归零）时复位提示语义。
  // flush 'sync'：把「归零即复位」做成同步不变量。若用默认 pre flush，同一 tick 内
  // 「开始→结束」两连发会被调度器合并为单个 job（flush 时新旧值相等 0→0，回调被
  // hasChanged 跳过），terminated 将卡在 true 永不复位。
  watch(
    runningCount,
    (count) => {
      if (count === 0) terminated.value = false;
    },
    { flush: 'sync' }
  );

  /** 各页签上一次的连接状态（diff 出迁移事件写日志）。 */
  const stateCache = new Map<number, string>();

  /** 状态快照落 store，并把逐 tab 状态迁移写入日志管线（可导出排查）。 */
  const applyStatuses = (next: RelayTabStatus[]): void => {
    statuses.value = next;
    const seen = new Set<number>();
    for (const status of next) {
      seen.add(status.tabId);
      const prev = stateCache.get(status.tabId);
      if (prev !== status.state) {
        stateCache.set(status.tabId, status.state);
        onLog(
          'info',
          'relay',
          'relay_status',
          `tab ${String(status.tabId)} → ${status.state}${status.detail ? ` (${status.detail})` : ''}`
        );
      }
    }
    for (const tabId of [...stateCache.keys()]) {
      if (!seen.has(tabId)) {
        stateCache.delete(tabId);
        onLog('info', 'relay', 'relay_status', `tab ${String(tabId)} → removed`);
      }
    }
  };

  let client: RelayStatusClient | null = null;
  const unsubscribes: Array<() => void> = [];

  return {
    statuses,
    selection,
    invokeLogs,
    runningCount,
    terminated,

    bind(nextClient, hooks = {}) {
      // 重复 bind：先解除旧订阅并清缓存（顶替语义），避免旧 client 推送串扰
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes.length = 0;
      stateCache.clear();
      client = nextClient;
      unsubscribes.push(
        nextClient.onUpdate(applyStatuses),
        nextClient.onInvokeLogs((entries) => {
          invokeLogs.value = entries;
        }),
        nextClient.onSelectionChange((nextSelection) => {
          selection.value = nextSelection;
          hooks.onSelectionChanged?.(nextSelection);
        })
      );
    },

    requestResetSelection() {
      // sendRequest 对未就绪连接静默丢弃（幂等语义），无需就绪判断
      client?.sendRequest({ type: 'reset-selection' });
    },

    terminateWait() {
      terminated.value = true;
    },

    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes.length = 0;
      stateCache.clear();
      client = null;
    },
  };
}
