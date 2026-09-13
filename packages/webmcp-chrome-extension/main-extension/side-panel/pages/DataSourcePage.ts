// 数据源设置页（页面功能级）：只读列表页 + 独立编辑子页面（2026-09-13 页面拆分改造）。
// - view（默认）→ DataSourceSummary 只读（连接统计 + 各页签状态徽章表）+「调整数据源」入口
// - edit → SubPageFrame 子页面（返回 icon + 标题栏）内嵌 DataSourcePicker（勾选/重置，
//   即点即生效语义保留）+ ConnectionActions（连接刷新）；返回即回只读状态表
// 执行锁：locked 时禁用进入编辑态（连接刷新属重建类操作，锁定期间亦不可用）。
// 本页不发起任何调用、不持有业务状态，仅按 relayStatus 是否可用裁剪编辑态操作区块。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, type PropType, type VNode } from 'vue';
import type { RelayTabSelection, RelayTabStatus } from '../../../core/relay-status-protocol';
import { t } from '../i18n';
import { SubPageFrame } from '../components/SubPageFrame';
import type { RelayStatusClient } from '../relay-status-client';
import { ConnectionActions } from '../components/datasource/ConnectionActions';
import { DataSourcePicker } from '../components/datasource/DataSourcePicker';
import { DataSourceSummary } from '../components/datasource/DataSourceSummary';

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
     * 执行锁（agent 对话或 relay 调用进行中）：编辑态入口与连接刷新禁用；
     * checkbox 勾选仅改选择集合，不受锁约束（口径在 Picker 内）。
     */
    locked: { type: Boolean, default: false },
    /**
     * relay 状态客户端：勾选/重置与「webmcp连接刷新 / relay连接刷新」按钮均借此向 SW
     * 发送请求；未注入时编辑态操作区块整体不渲染。
     */
    relayStatus: { type: Object as PropType<RelayStatusClient | null>, default: null },
  },
  setup(props) {
    /** 页面模式：view = 只读状态表；edit = 选择 + 连接刷新（跨页签切换保留）。 */
    const mode = ref<'view' | 'edit'>('view');

    return () => {
      // 编辑态 = 独立子页面（SubPageFrame：返回 icon + 标题栏，返回即回只读状态表；
      // 勾选/重置为即点即生效操作，无草稿语义，返回不回滚已生效的选择）
      const body: (VNode | null)[] =
        mode.value === 'view'
          ? [
              h(DataSourceSummary, { statuses: props.statuses }),
              h('div', { class: 'page-mode-actions' }, [
                h('button', {
                  type: 'button',
                  disabled: props.locked,
                  onClick: () => {
                    mode.value = 'edit';
                  },
                }, t('ds.adjust')),
                props.locked ? h('p', { class: 'relay-page-status' }, t('ds.lockedHint')) : null,
              ]),
            ]
          : [
              h(SubPageFrame, { title: t('ds.picker.title'), onBack: () => { mode.value = 'view'; } }, {
                default: () => [
                  h(DataSourcePicker, {
                    statuses: props.statuses,
                    selection: props.selection,
                    relayStatus: props.relayStatus,
                  }),
                  props.relayStatus
                    ? h(ConnectionActions, { locked: props.locked, relayStatus: props.relayStatus })
                    : null,
                ],
              }),
            ];
      return h(
        'div',
        { class: 'datasource-page', style: { display: props.active ? '' : 'none' } },
        body
      );
    };
  },
});
