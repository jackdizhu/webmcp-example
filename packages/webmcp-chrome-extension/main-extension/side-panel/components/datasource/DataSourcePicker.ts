// 数据源选择组件（编辑态）：全局标签页数据源勾选 + 重置入口。
// 与 DataSourceSummary（只读状态表）分离（2026-09-13 编辑态/只读态拆分）：
// 状态徽章移入 Summary，本组件只保留选择交互。
// 语义保留（2026-09-12 口径）：checkbox 勾选/重置为「操作」而非表单 —— 即点即生效
// （合并选中集发 SW，全端生效），无草稿、不受执行锁约束。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, type PropType } from 'vue';
import type { RelayTabSelection, RelayTabStatus } from '../../../../core/relay-status-protocol';
import { t } from '../../i18n';
import { logEvent } from '../../logger';
import type { RelayStatusClient } from '../../relay-status-client';

export const DataSourcePicker = defineComponent({
  name: 'DataSourcePicker',
  props: {
    /** 全部 http(s) 标签页状态（含未选中页签的 stopped 占位，供 checkbox 列表）。 */
    statuses: { type: Array as PropType<RelayTabStatus[]>, required: true },
    /** 当前全局数据源选择（SW 推送；默认 = 打开侧栏时的活动页签）。 */
    selection: { type: Object as PropType<RelayTabSelection>, required: true },
    /** relay 状态客户端：勾选/重置借此向 SW 发送请求；未注入时操作不生效。 */
    relayStatus: { type: Object as PropType<RelayStatusClient | null>, default: null },
  },
  setup(props) {
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

    return () => {
      // 选中项在前，其余按 tabId 升序，顺序稳定
      const sorted = [...props.statuses].sort((a, b) => {
        const aSelected = a.selected === true ? 0 : 1;
        const bSelected = b.selected === true ? 0 : 1;
        if (aSelected !== bSelected) return aSelected - bSelected;
        return a.tabId - b.tabId;
      });
      return h('section', { class: 'relay-source-picker' }, [
        h('h4', t('ds.picker.title')),
        h(
          'p',
          { class: 'relay-source-mode' },
          t('ds.picker.globalSelection', { count: props.selection.tabIds.length })
        ),
        sorted.length === 0
          ? h('p', { class: 'relay-page-empty-status' }, t('ds.picker.empty'))
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
                      status.title || status.url || t('common.tabLabel', { id: status.tabId })
                    ),
                  ]),
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
          t('ds.picker.reset')
        ),
      ]);
    };
  },
});
