// 数据源页只读展示组件：全局标签页连接状态摘要 + 各页签状态表（含状态徽章）。
// 与 DataSourcePicker（编辑：勾选/重置）分离（2026-09-13 编辑态/只读态拆分）：
// 本组件零输入控件，纯快照展示（数据源 = SW 推送的 statuses 只读镜像）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, type PropType } from 'vue';
import type { RelayTabStatus } from '../../../../core/relay-status-protocol';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n/zh-CN';

/** 各连接状态的 i18n 键（与 RelayStatusBar 共用同一套键）。 */
const STATE_KEY: Record<string, MessageKey> = {
  connected: 'relayBar.state.connected',
  connecting: 'relayBar.state.connecting',
  reconnecting: 'relayBar.state.reconnecting',
  dormant: 'relayBar.state.dormant',
  stopped: 'relayBar.state.stopped',
};

export const DataSourceSummary = defineComponent({
  name: 'DataSourceSummary',
  props: {
    /** 全部 http(s) 标签页状态（SW 推送快照，只读展示）。 */
    statuses: { type: Array as PropType<RelayTabStatus[]>, required: true },
  },
  setup(props) {
    return () => {
      if (props.statuses.length === 0) {
        return h('section', { class: 'datasource-summary' }, [
          h('h4', t('ds.summary.title')),
          h('p', { class: 'relay-page-empty-status' }, t('ds.summary.empty')),
        ]);
      }
      const connected = props.statuses.filter((status) => status.state === 'connected').length;
      const selectedCount = props.statuses.filter((status) => status.selected === true).length;
      const sorted = [...props.statuses].sort((a, b) => a.tabId - b.tabId);
      return h('section', { class: 'datasource-summary' }, [
        h('h4', t('ds.summary.title')),
        h(
          'p',
          { class: 'relay-page-status' },
          t('ds.summary.stats', {
            connected,
            selected: selectedCount,
            total: props.statuses.length,
          })
        ),
        h(
          'ul',
          { class: 'datasource-summary-list' },
          sorted.map((status) =>
            h('li', { class: 'relay-source-item', key: String(status.tabId) }, [
              h(
                'span',
                { class: 'relay-source-title' },
                status.title || status.url || t('common.tabLabel', { id: status.tabId })
              ),
              h(
                'span',
                { class: ['relay-badge', `relay-badge-${status.state}`] },
                (() => {
                  const key = STATE_KEY[status.state];
                  return key !== undefined ? t(key) : status.state;
                })()
              ),
            ])
          )
        ),
      ]);
    };
  },
});
