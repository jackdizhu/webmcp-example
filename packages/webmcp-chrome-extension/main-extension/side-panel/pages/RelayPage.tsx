// relay 调用页（页面功能级）：只读调用链路日志。
// 数据来源：SW 在 handleInvoke 采集（started/finished），经 relay-status Port 推送；
// 本页不发起任何调用。数据源选择与连接刷新已拆分至「数据源设置」页
// （2026-09-12 页面结构调整），本页仅负责调用日志的只读展示。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { defineComponent, type PropType } from 'vue';
import type { RelayInvokeLogEntry } from '../../../core/relay-status-protocol';
import { t } from '../i18n';

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
    /** 调用日志（App 层维护的环形缓冲，时间正序；渲染时倒序展示最新在前）。 */
    invokeLogs: { type: Array as PropType<RelayInvokeLogEntry[]>, required: true },
    /** 执行中的调用数（ok 缺省的条目数）。 */
    runningCount: { type: Number, required: true },
    /** 用户已点「终止」但仍有调用未结束（提示后台会照常完成）。 */
    terminated: { type: Boolean, required: true },
  },
  setup(props) {
    const renderEntry = (entry: RelayInvokeLogEntry) => {
      const running = entry.ok === undefined;
      const badgeClass = running
        ? 'invoke-badge-running'
        : entry.ok
          ? 'invoke-badge-ok'
          : 'invoke-badge-fail';
      const badgeText = running
        ? t('common.state.running')
        : entry.ok
          ? t('common.state.ok')
          : t('common.state.fail');
      return (
        <li
          class={['invoke-item', running ? 'invoke-item-running' : '']}
          key={`${entry.callId}-${String(entry.startedAt)}`}
        >
          <div class="invoke-item-head">
            <span class="invoke-time">{formatTime(entry.startedAt)}</span>
            <span class="invoke-tool">{entry.toolName}</span>
            <span class={['invoke-badge', badgeClass]}>{badgeText}</span>
            {entry.elapsedMs !== undefined ? (
              <span class="invoke-elapsed">{`${String(entry.elapsedMs)}ms`}</span>
            ) : null}
            <span class="invoke-tab">{`tab ${String(entry.tabId)}`}</span>
          </div>
          <div class="invoke-args">{`args: ${entry.argsSummary}`}</div>
          {entry.resultSummary !== undefined ? (
            <div class={['invoke-result', entry.ok ? '' : 'invoke-result-failed']}>
              {`result: ${entry.resultSummary}`}
            </div>
          ) : null}
        </li>
      );
    };

    return () => (
      <div class="relay-page" style={{ display: props.active ? '' : 'none' }}>
        <section class="relay-page-header">
          <h4>{t('relayPage.title')}</h4>
          {props.runningCount > 0 ? (
            <p class="relay-page-running">{t('relayPage.running', { count: props.runningCount })}</p>
          ) : null}
          {props.terminated && props.runningCount > 0 ? (
            <p class="relay-page-terminated">{t('relayPage.terminated')}</p>
          ) : null}
        </section>
        {props.invokeLogs.length === 0 ? (
          <p class="relay-page-empty">{t('relayPage.empty')}</p>
        ) : (
          <ul class="invoke-list">{[...props.invokeLogs].reverse().map(renderEntry)}</ul>
        )}
      </div>
    );
  },
});
