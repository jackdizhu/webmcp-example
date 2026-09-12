// 设置页（页面功能级）：包一层 Tab 显隐语义，表单本体复用 components/SettingsPanel。
// 独立组件不感知页面路由语义（分层约定：显隐收敛在页面层）。
// 日志区块管理（条数/导出/清空）为页面级逻辑，自持状态与 handler（2026-09-12
// App.ts 页面级归拢：原 App 侧 logCount/hint/export/clear 下沉到本页）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, watch, type PropType } from 'vue';
import type { PanelSettings } from '../panel-client';
import { SettingsPanel } from '../components/SettingsPanel';
import { clearLogs, exportLogs, logCount, logEvent } from '../logger';

export const SettingsPage = defineComponent({
  name: 'SettingsPage',
  props: {
    /** 本页是否激活（非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    settings: { type: Object as PropType<PanelSettings>, required: true },
    busy: { type: Boolean, required: true },
  },
  emits: {
    save: null,
  },
  setup(props, { emit }) {
    // ---- 本地日志区块状态（原 App 层下沉） ----
    const logCountText = ref('');
    const logHint = ref('');

    const refreshLogCount = async (): Promise<void> => {
      logCountText.value = `${await logCount()} 条`;
    };

    const handleExportLogs = async (): Promise<void> => {
      const filename = await exportLogs();
      if (filename) {
        logHint.value = `已导出 ${filename}`;
        logEvent('info', 'app', 'logs_exported', filename);
      } else {
        logHint.value = '暂无日志可导出';
      }
      await refreshLogCount();
    };

    const handleClearLogs = async (): Promise<void> => {
      await clearLogs();
      logHint.value = '日志已清空';
      logEvent('info', 'app', 'logs_cleared');
      await refreshLogCount();
    };

    // 进入设置页时清空提示并刷新日志条数展示（原 App watch(activeTab) settings 分支）
    watch(
      () => props.active,
      (isActive) => {
        if (isActive) {
          logHint.value = '';
          void refreshLogCount();
        }
      },
      { immediate: true }
    );

    return () =>
      h(
        'div',
        { class: 'settings-page', style: { display: props.active ? '' : 'none' } },
        [
          h(SettingsPanel, {
            settings: props.settings,
            busy: props.busy,
            logCountText: logCountText.value,
            logHint: logHint.value,
            onSave: () => emit('save'),
            onExportLogs: () => void handleExportLogs(),
            onClearLogs: () => void handleClearLogs(),
          }),
        ]
      );
  },
});
