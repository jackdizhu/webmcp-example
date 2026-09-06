// relay 连接状态栏：摘要行 + 可展开的逐标签页明细。
// 独立可复用组件放 components/（分层约定）；模板必须用 h() 渲染函数
// （MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref } from 'vue';
import type { RelayTabStatus } from '../../../core/relay-status-protocol';

/** 各连接状态的中文标签。 */
const STATE_TEXT: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  dormant: '休眠',
  stopped: '已停止',
};

/** 摘要聚合：仅统计选中标签页（未选中的不连 relay，不参与摘要）。
 * 任一已连接即绿；否则有恢复中即琥珀；被 LNA 拦截提示授权；未选中任何页签提示待机。 */
function summarize(statuses: RelayTabStatus[]): { cls: string; text: string } {
  const selected = statuses.filter((s) => s.selected === true);
  if (selected.some((s) => s.state === 'connected')) {
    const connected = selected.filter((s) => s.state === 'connected').length;
    return { cls: 'relay-dot-on', text: `relay 已连接 · ${String(connected)} 个源` };
  }
  if (selected.some((s) => s.state === 'connecting' || s.state === 'reconnecting')) {
    return { cls: 'relay-dot-warn', text: `relay 连接中 · ${String(selected.length)} 个源` };
  }
  if (selected.some((s) => s.lnaBlocked)) {
    return { cls: 'relay-dot-warn', text: 'relay 被浏览器本地网络权限拦截 · 展开查看修复步骤' };
  }
  if (selected.length > 0) {
    return { cls: 'relay-dot-off', text: 'relay 休眠 · 未发现本机 relay' };
  }
  return { cls: 'relay-dot-off', text: 'relay 待机 · 未选中任何标签页' };
}

function formatEndpoint(status: RelayTabStatus): string {
  if (!status.endpoint) return '未建立连接';
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
                  h('span', { class: 'relay-item-title' }, status.title || status.url || `标签页 ${String(status.tabId)}`),
                  h(
                    'span',
                    { class: ['relay-badge', `relay-badge-${status.state}`] },
                    STATE_TEXT[status.state] ?? status.state
                  ),
                ]),
                h('div', { class: 'relay-item-meta' }, [
                  `${formatEndpoint(status)} · ${String(status.toolsCount)} 个工具`,
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
