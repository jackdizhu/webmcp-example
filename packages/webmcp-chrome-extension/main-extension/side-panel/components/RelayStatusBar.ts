// relay 连接状态栏：摘要行 + 可展开的逐标签页明细。
// 独立可复用组件放 components/（分层约定）；模板必须用 h() 渲染函数
// （MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
// 文案经全局 i18n store（t() 直读 locale ref），切换语言自动重渲染。
import { defineComponent, h, ref } from 'vue';
import type { RelayTabStatus } from '../../../core/relay-status-protocol';
import { t } from '../i18n';
import type { MessageKey } from '../i18n/zh-CN';

/** 各连接状态的 i18n 键。 */
const STATE_KEY: Record<string, MessageKey> = {
  connected: 'relayBar.state.connected',
  connecting: 'relayBar.state.connecting',
  reconnecting: 'relayBar.state.reconnecting',
  dormant: 'relayBar.state.dormant',
  stopped: 'relayBar.state.stopped',
};

/** 摘要聚合：仅统计选中标签页（未选中的不连 relay，不参与摘要）。
 * 任一已连接即绿；否则有恢复中即琥珀；被 LNA 拦截提示授权；未选中任何页签提示待机。 */
function summarize(statuses: RelayTabStatus[]): { cls: string; text: string } {
  const selected = statuses.filter((s) => s.selected === true);
  if (selected.some((s) => s.state === 'connected')) {
    const connected = selected.filter((s) => s.state === 'connected').length;
    return { cls: 'relay-dot-on', text: t('relayBar.summary.connected', { count: connected }) };
  }
  if (selected.some((s) => s.state === 'connecting' || s.state === 'reconnecting')) {
    return { cls: 'relay-dot-warn', text: t('relayBar.summary.connecting', { count: selected.length }) };
  }
  if (selected.some((s) => s.lnaBlocked)) {
    return { cls: 'relay-dot-warn', text: t('relayBar.summary.lnaBlocked') };
  }
  if (selected.length > 0) {
    return { cls: 'relay-dot-off', text: t('relayBar.summary.dormant') };
  }
  return { cls: 'relay-dot-off', text: t('relayBar.summary.standby') };
}

function formatEndpoint(status: RelayTabStatus): string {
  if (!status.endpoint) return t('relayBar.noEndpoint');
  return `${status.endpoint.host}:${String(status.endpoint.port)}`;
}

export const RelayStatusBar = defineComponent({
  name: 'RelayStatusBar',
  props: {
    statuses: { type: Array as () => RelayTabStatus[], required: true },
  },
  setup(props) {
    const expanded = ref(false);

    return () => {
      const summary = summarize(props.statuses);
      const children = [
        h(
          'button',
          {
            class: 'relay-summary',
            type: 'button',
            onClick: () => {
              expanded.value = !expanded.value;
            },
          },
          [
            h('span', { class: ['relay-dot', summary.cls] }),
            h('span', { class: 'relay-summary-text' }, summary.text),
            h('span', { class: 'relay-caret' }, expanded.value ? '▾' : '▸'),
          ]
        ),
      ];

      if (expanded.value && props.statuses.length > 0) {
        children.push(
          h(
            'ul',
            { class: 'relay-list' },
            props.statuses.map((status) =>
              h('li', { class: 'relay-item', key: String(status.tabId) }, [
                h('div', { class: 'relay-item-head' }, [
                  h(
                    'span',
                    { class: 'relay-item-title' },
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
                ]),
                h('div', { class: 'relay-item-meta' }, [
                  `${formatEndpoint(status)} · ${t('common.toolsCount', { count: status.toolsCount })}`,
                  status.detail ? ` · ${status.detail}` : '',
                ]),
              ])
            )
          )
        );
      }

      return h('div', { class: 'relay-bar' }, children);
    };
  },
});
