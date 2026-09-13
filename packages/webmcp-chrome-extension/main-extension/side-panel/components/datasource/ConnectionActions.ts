// 连接刷新操作组件：webmcp / relay 连接重建入口（操作态，非表单）。
// 自 DataSourcePage 迁出（2026-09-13 编辑态/只读态拆分）：fire-and-forget，
// 本地 reconnecting ref 仅做 1s 按钮节流，重建结果经顶部 RelayStatusBar 状态快照展示。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, type PropType } from 'vue';
import { t } from '../../i18n';
import { logEvent } from '../../logger';
import type { RelayStatusClient } from '../../relay-status-client';

export const ConnectionActions = defineComponent({
  name: 'ConnectionActions',
  props: {
    /** 执行锁（agent 对话或 relay 调用进行中）：重建属破坏性操作，锁定期间禁用。 */
    locked: { type: Boolean, default: false },
    /** relay 状态客户端：刷新按钮借此向 SW 发送请求；未注入时本组件不渲染（页面层控制）。 */
    relayStatus: { type: Object as PropType<RelayStatusClient | null>, default: null },
  },
  setup(props) {
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

    return () =>
      h('section', { class: 'datasource-connections' }, [
        h('h4', t('ds.actions.title')),
        h(
          'p',
          { class: 'relay-source-mode' },
          t('ds.actions.hint')
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
            reconnecting.value === 'webmcp' ? t('ds.actions.rebuilding') : t('ds.actions.webmcp')
          ),
          h(
            'button',
            {
              class: 'ghost',
              type: 'button',
              disabled: props.locked || reconnecting.value !== null,
              onClick: () => recreateConnection('relay'),
            },
            reconnecting.value === 'relay' ? t('ds.actions.rebuilding') : t('ds.actions.relay')
          ),
        ]),
      ]);
  },
});
