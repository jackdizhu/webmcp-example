// 数据源设置页（页面功能级）：全局标签页数据源选择 + 连接刷新入口。
// 从原 relay 调用页拆出（2026-09-12 页面结构调整）：数据源选择与 agent / tools 调试 /
// relay 三端共用（Q2 决策），是与调用日志无关的「设置」语义，独立成页。
// 「webmcp连接刷新 / relay连接刷新」按钮同步自 tools 调试页迁入 —— 连接管理类操作
// 与数据源选择同属连接编排语义。本页不发起任何调用。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, type PropType, type VNode } from 'vue';
import type { RelayTabSelection, RelayTabStatus } from '../../../core/relay-status-protocol';
import { logEvent } from '../logger';
import type { RelayStatusClient } from '../relay-status-client';

/** 各连接状态的中文标签（与 RelayStatusBar 保持一致）。 */
const STATE_TEXT: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  dormant: '休眠',
  stopped: '未连接',
};

export const DataSourcePage = defineComponent({
  name: 'DataSourcePage',
  props: {
    /** 本页是否激活（非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    /** 全部 http(s) 标签页状态（含未选中页签的 stopped 占位，供 checkbox 列表）。 */
    statuses: { type: Array as PropType<RelayTabStatus[]>, required: true },
    /** 当前全局数据源选择（SW 推送；默认 = 打开侧栏时的活动页签）。 */
    selection: { type: Object as PropType<RelayTabSelection>, required: true },
    /**
     * 执行锁（agent 对话或 relay 调用进行中）：连接刷新属重建类操作，锁定期间禁用
     * （与原 tools 调试页按钮口径一致）；checkbox 勾选仅改选择集合，不受锁约束。
     */
    locked: { type: Boolean, default: false },
    /**
     * relay 状态客户端：勾选/重置与「webmcp连接刷新 / relay连接刷新」按钮均借此向 SW
     * 发送请求；未注入时操作区块整体不渲染。
     */
    relayStatus: { type: Object as () => RelayStatusClient | null, default: null },
  },
  setup(props) {
    const renderStatusSummary = (): VNode => {
      if (props.statuses.length === 0) {
        return h('p', { class: 'relay-page-empty-status' }, '暂无 http(s) 标签页');
      }
      const connected = props.statuses.filter((status) => status.state === 'connected').length;
      const selectedCount = props.statuses.filter((status) => status.selected === true).length;
      return h('p', { class: 'relay-page-status' }, [
        `已连接 ${String(connected)} 个源 · 已选 ${String(selectedCount)} / ${String(props.statuses.length)} 个标签页`,
      ]);
    };

    /** 数据源选择列表：选中项在前，其余按 tabId 升序，顺序稳定。 */
    const renderSourcePicker = (): VNode => {
      const sorted = [...props.statuses].sort((a, b) => {
        const aSelected = a.selected === true ? 0 : 1;
        const bSelected = b.selected === true ? 0 : 1;
        if (aSelected !== bSelected) return aSelected - bSelected;
        return a.tabId - b.tabId;
      });
      return h('section', { class: 'relay-source-picker' }, [
        h('h4', '数据源选择'),
        h(
          'p',
          { class: 'relay-source-mode' },
          `全局选择：已选 ${String(props.selection.tabIds.length)} 个标签页（agent / tools 调试 / relay 三端共用；不随切换页签变化）`
        ),
        sorted.length === 0
          ? h('p', { class: 'relay-page-empty-status' }, '暂无可选标签页')
          : h(
              'ul',
              { class: 'relay-source-list' },
              sorted.map((status) =>
                h('li', { class: 'relay-source-item', key: String(status.tabId) }, [
                  h('label', { class: 'relay-source-label' }, [
                    h('input', {
                      type: 'checkbox',
                      checked: status.selected === true,
                      onChange: (event: Event) => {
                        toggleTab(status.tabId, (event.target as HTMLInputElement).checked);
                      },
                    }),
                    h(
                      'span',
                      { class: 'relay-source-title' },
                      status.title || status.url || `标签页 ${String(status.tabId)}`
                    ),
                  ]),
                  h(
                    'span',
                    { class: ['relay-badge', `relay-badge-${status.state}`] },
                    STATE_TEXT[status.state] ?? status.state
                  ),
                ])
              )
            ),
        h(
          'button',
          {
            class: 'ghost relay-source-reset',
            type: 'button',
            onClick: () => resetSelection(),
          },
          '重置为当前活动页签（单选）'
        ),
      ]);
    };

    // ---- 数据源选择操作（App 层下沉，2026-09-12 页面级归拢）----
    // checkbox 勾选仅改选择集合，不受执行锁约束（与原 App.toggleRelayTab 口径一致）。

    /** 勾选/取消某个标签页：合并出新选中集发给 SW（全端生效：relay + agent + 调试）。 */
    const toggleTab = (tabId: number, checked: boolean): void => {
      if (!props.relayStatus) return;
      const next = new Set(props.selection.tabIds);
      if (checked) next.add(tabId);
      else next.delete(tabId);
      props.relayStatus.sendRequest({ type: 'set-selection', tabIds: [...next] });
      logEvent('info', 'datasource', 'relay_selection_toggle', `tab ${String(tabId)} → ${checked ? 'selected' : 'deselected'}`);
    };

    /** 重置为当前活动页签（单选，覆盖手动多选，Q5 语义）。 */
    const resetSelection = (): void => {
      props.relayStatus?.sendRequest({ type: 'reset-selection' });
      logEvent('info', 'datasource', 'relay_selection_reset', 'active-tab');
    };

    // ---- 连接刷新（重建连接类操作，fire-and-forget，结果经状态快照展示） ----

    /** 连接刷新进行中标记：重建是异步编排（dispose → reconnect → resync），短暂禁用按钮防连点。 */
    const reconnecting = ref<'webmcp' | 'relay' | null>(null);

    const recreateConnection = (mode: 'webmcp' | 'relay'): void => {
      if (!props.relayStatus || reconnecting.value) return;
      reconnecting.value = mode;
      logEvent('info', 'datasource', mode === 'webmcp' ? 'webmcp_reconnect' : 'relay_reconnect', {});
      try {
        props.relayStatus.sendRequest({ type: mode === 'webmcp' ? 'webmcp-reconnect' : 'relay-reconnect' });
      } finally {
        // SW 端重建异步执行：此处仅做按钮节流，状态变化由 RelayStatusBar 展示
        setTimeout(() => {
          reconnecting.value = null;
        }, 1000);
      }
    };

    const renderConnectionActions = (): VNode | null => {
      if (!props.relayStatus) return null;
      return h('section', { class: 'datasource-connections' }, [
        h('h4', '连接刷新'),
        h(
          'p',
          { class: 'relay-source-mode' },
          'webmcp 连接 = 扩展 → 页面工具桥接；relay 连接 = 扩展 → 本机 relay 服务。重建期间状态以顶部状态栏为准。'
        ),
        h('div', { class: 'debug-actions' }, [
          h(
            'button',
            {
              class: 'ghost',
              type: 'button',
              disabled: props.locked || reconnecting.value !== null,
              onClick: () => recreateConnection('webmcp'),
            },
            reconnecting.value === 'webmcp' ? '重建中…' : 'webmcp连接刷新'
          ),
          h(
            'button',
            {
              class: 'ghost',
              type: 'button',
              disabled: props.locked || reconnecting.value !== null,
              onClick: () => recreateConnection('relay'),
            },
            reconnecting.value === 'relay' ? '重建中…' : 'relay连接刷新'
          ),
        ]),
      ]);
    };

    return () =>
      h(
        'div',
        { class: 'datasource-page', style: { display: props.active ? '' : 'none' } },
        [renderStatusSummary(), renderSourcePicker(), renderConnectionActions()]
      );
  },
});
