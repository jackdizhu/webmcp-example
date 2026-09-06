// 设置页（页面功能级）：包一层 Tab 显隐语义，表单本体复用 components/SettingsPanel。
// 独立组件不感知页面路由语义（分层约定：显隐收敛在页面层）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, type PropType } from 'vue';
import type { PanelSettings } from '../panel-client';
import { SettingsPanel } from '../components/SettingsPanel';

export const SettingsPage = defineComponent({
  name: 'SettingsPage',
  props: {
    /** 本页是否激活（非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    settings: { type: Object as PropType<PanelSettings>, required: true },
    busy: { type: Boolean, required: true },
    logCountText: { type: String, required: true },
    logHint: { type: String, required: true },
  },
  emits: {
    save: null,
    'export-logs': null,
    'clear-logs': null,
    'toggle-debug': null,
  },
  setup(props, { emit }) {
    return () =>
      h(
        'div',
        { class: 'settings-page', style: { display: props.active ? '' : 'none' } },
        [
          h(SettingsPanel, {
            settings: props.settings,
            busy: props.busy,
            logCountText: props.logCountText,
            logHint: props.logHint,
            onSave: () => emit('save'),
            onExportLogs: () => emit('export-logs'),
            onClearLogs: () => emit('clear-logs'),
            onToggleDebug: () => emit('toggle-debug'),
          }),
        ]
      );
  },
});
