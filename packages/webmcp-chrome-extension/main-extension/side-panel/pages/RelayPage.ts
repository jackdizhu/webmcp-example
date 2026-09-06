// relay 调用页（页面功能级）：数据源选择（checkbox 多选）+ 只读调用链路日志。
// 数据来源：SW 在 handleInvoke 采集（started/finished），经 relay-status Port 推送；
// 本页不发起任何调用 —— 标签页勾选只改「哪些页签的数据暴露给 relay」，
// 未选中的页签不建立 relay 连接，relay 端获取数据时过滤不传递。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, type PropType, type VNode } from 'vue';
import type { RelayInvokeLogEntry, RelayTabSelection, RelayTabStatus } from '../../../core/relay-status-protocol';

/** 各连接状态的中文标签（与 RelayStatusBar 保持一致）。 */
const STATE_TEXT: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  dormant: '休眠',
  stopped: '未连接',
};

/** 时间戳 → HH:MM:SS 展示。 */
function formatTime(startedAt: number): string {
  const date = new Date(startedAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export const RelayPage = defineComponent({
  name: 'RelayPage',
  props: {
    /** 本页是否激活（非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    /** 全部 http(s) 标签页状态（含未选中页签的 stopped 占位，供 checkbox 列表）。 */
    statuses: { type: Array as PropType<RelayTabStatus[]>, required: true },
    /** 当前数据源选择（自动模式单选活动页签 / 手动 checkbox 集合）。 */
    selection: { type: Object as PropType<RelayTabSelection>, required: true },
    /** 调用日志（App 层维护的环形缓冲，时间正序；渲染时倒序展示最新在前）。 */
    invokeLogs: { type: Array as PropType<RelayInvokeLogEntry[]>, required: true },
    /** 执行中的调用数（ok 缺省的条目数）。 */
    runningCount: { type: Number, required: true },
    /** 用户已点「终止」但仍有调用未结束（提示后台会照常完成）。 */
    terminated: { type: Boolean, required: true },
  },
  emits: {
    /** 勾选/取消某个标签页 → App 组合新选中集发给 SW。 */
    toggleTab: (tabId: number, checked: boolean) =>
      typeof tabId === 'number' && typeof checked === 'boolean',
    /** 恢复默认（跟随当前活动页签，单选）。 */
    resetSelection: () => true,
  },
  setup(props, { emit }) {
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
          props.selection.mode === 'auto'
            ? '默认模式：仅当前活动标签页（单选）；勾选其他标签页可多选'
            : `手动模式：已选 ${String(props.selection.tabIds.length)} 个标签页，不随切换页签变化`
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
                        emit('toggleTab', status.tabId, (event.target as HTMLInputElement).checked);
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
        props.selection.mode === 'manual'
          ? h(
              'button',
              {
                class: 'ghost relay-source-reset',
                type: 'button',
                onClick: () => emit('resetSelection'),
              },
              '恢复默认（跟随活动标签页）'
            )
          : null,
      ]);
    };

    const renderEntry = (entry: RelayInvokeLogEntry): VNode => {
      const running = entry.ok === undefined;
      const badgeClass = running
        ? 'invoke-badge-running'
        : entry.ok
          ? 'invoke-badge-ok'
          : 'invoke-badge-fail';
      const badgeText = running ? '执行中' : entry.ok ? '成功' : '失败';
      return h('li', { class: ['invoke-item', running ? 'invoke-item-running' : ''], key: `${entry.callId}-${String(entry.startedAt)}` }, [
        h('div', { class: 'invoke-item-head' }, [
          h('span', { class: 'invoke-time' }, formatTime(entry.startedAt)),
          h('span', { class: 'invoke-tool' }, entry.toolName),
          h('span', { class: ['invoke-badge', badgeClass] }, badgeText),
          entry.elapsedMs !== undefined
            ? h('span', { class: 'invoke-elapsed' }, `${String(entry.elapsedMs)}ms`)
            : null,
          h('span', { class: 'invoke-tab' }, `tab ${String(entry.tabId)}`),
        ]),
        h('div', { class: 'invoke-args' }, `args: ${entry.argsSummary}`),
        entry.resultSummary !== undefined
          ? h('div', { class: ['invoke-result', entry.ok ? '' : 'invoke-result-failed'] }, `result: ${entry.resultSummary}`)
          : null,
      ]);
    };

    return () =>
      h(
        'div',
        { class: 'relay-page', style: { display: props.active ? '' : 'none' } },
        [
          h('section', { class: 'relay-page-header' }, [
            h('h4', 'relay 调用日志（只读）'),
            renderStatusSummary(),
            props.runningCount > 0
              ? h('p', { class: 'relay-page-running' }, `${String(props.runningCount)} 个调用执行中…`)
              : null,
            props.terminated && props.runningCount > 0
              ? h(
                  'p',
                  { class: 'relay-page-terminated' },
                  '已终止等待，执行锁已解除；后台调用仍会完成并记录在下方日志中。'
                )
              : null,
          ]),
          renderSourcePicker(),
          props.invokeLogs.length === 0
            ? h('p', { class: 'relay-page-empty' }, '暂无调用记录。外部 MCP agent 经 relay 调用页面工具时，会在这里实时展示。')
            : h('ul', { class: 'invoke-list' }, [...props.invokeLogs].reverse().map(renderEntry)),
        ]
      );
  },
});
