// 设置页（页面功能级）：查看态 / 编辑态互斥双模式 + Tab 显隐语义。
// 双模式分离（2026-09-13）：mode 自持于本页（App/TabBar 零感知），同一时刻只渲染一种形态：
// - view（默认）→ SettingsSummary 只读摘要（已保存生效配置，apiKey 脱敏）+「编辑配置」入口
// - edit → SettingsForm 草稿表单（保存/取消在表单内，保存成功回查看态）
// mode 跨页签切换保留；dirty 沿用「仅提示不阻断」口径（Form 内提示，不阻断切页签）。
// 本页负责把 Form 的 save(草稿) / dirty 上抛给 App。
// 日志区块管理（条数/导出/清空）为操作类非表单，两种模式常驻（2026-09-13 决策 ③）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, watch, type PropType, type VNode } from 'vue';
import { t } from '../i18n';
import { SubPageFrame } from '../components/SubPageFrame';
import type { PanelSettings } from '../panel-client';
import { SettingsForm } from '../components/settings/SettingsForm';
import { SettingsSummary } from '../components/settings/SettingsSummary';
import { clearLogs, exportLogs, logCount, logEvent } from '../logger';

export const SettingsPage = defineComponent({
  name: 'SettingsPage',
  props: {
    /** 本页是否激活（非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    /** 已保存生效的基线配置（App live reactive 对象；保存动作经 App 合并落盘）。 */
    settings: { type: Object as PropType<PanelSettings>, required: true },
    busy: { type: Boolean, required: true },
  },
  emits: {
    /** 保存：透传 SettingsForm 草稿快照，App 合并进基线并持久化。 */
    save: (draft: PanelSettings) => Boolean(draft),
  },
  setup(props, { emit }) {
    /** 页面模式：view = 只读摘要；edit = 草稿表单（跨页签切换保留）。 */
    const mode = ref<'view' | 'edit'>('view');

    // ---- 本地日志区块状态（原 App 层下沉） ----
    /** 日志条数（null = 未刷新过；展示文案在渲染时经 t() 按当前语言组装）。 */
    const logCountValue = ref<number | null>(null);
    const logHint = ref('');

    const refreshLogCount = async (): Promise<void> => {
      logCountValue.value = await logCount();
    };

    const handleExportLogs = async (): Promise<void> => {
      const filename = await exportLogs();
      if (filename) {
        logHint.value = t('settings.exported', { name: filename });
        logEvent('info', 'app', 'logs_exported', filename);
      } else {
        logHint.value = t('settings.noLogsToExport');
      }
      await refreshLogCount();
    };

    const handleClearLogs = async (): Promise<void> => {
      await clearLogs();
      logHint.value = t('settings.logsCleared');
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

    // 表单 dirty 状态（Form 上抛；view 态摘要显示「有未保存修改」提示用）
    const formDirty = ref(false);

    const renderLogs = (): (VNode | null)[] => [
      h('div', { class: 'settings-logs' }, [
        h(
          'span',
          { class: 'settings-log-count' },
          logCountValue.value !== null ? t('settings.logsCount', { count: logCountValue.value }) : ''
        ),
        h('button', { class: 'ghost', type: 'button', onClick: () => void handleExportLogs() }, t('settings.exportLogs')),
        h('button', { class: 'ghost', type: 'button', onClick: () => void handleClearLogs() }, t('settings.clearLogs')),
      ]),
      logHint.value ? h('p', { class: 'settings-hint' }, logHint.value) : null,
    ];

    return () => {
      // 编辑态 = 独立子页面（SubPageFrame：返回 icon + 标题栏，返回/取消回只读列表页）；
      // 日志区块属查看态信息（2026-09-13 页面拆分改造：不再两种模式常驻）
      const body: (VNode | null)[] =
        mode.value === 'view'
          ? [
              h(SettingsSummary, { settings: props.settings, dirty: formDirty.value }),
              h('div', { class: 'page-mode-actions page-mode-actions-padded' }, [
                h('button', {
                  type: 'button',
                  disabled: props.busy,
                  onClick: () => {
                    mode.value = 'edit';
                  },
                }, t('settings.editConfig')),
                props.busy ? h('p', { class: 'settings-hint' }, t('settings.lockedHint')) : null,
              ]),
              ...renderLogs(),
            ]
          : [
              h(SubPageFrame, { title: t('settings.editConfig'), onBack: () => { mode.value = 'view'; } }, {
                default: () => [
                  h(SettingsForm, {
                    settings: props.settings,
                    editing: mode.value === 'edit',
                    busy: props.busy,
                    onSave: (draft: PanelSettings) => {
                      // 保存成功后回查看态（App 侧 persistSettings 还会切回对话页）
                      emit('save', draft);
                      mode.value = 'view';
                    },
                    onCancel: () => {
                      // 取消编辑 = 丢弃草稿（Form 内已对齐基线）+ 退回查看态；
                      // 语义收敛在页面层，不上抛 App
                      mode.value = 'view';
                    },
                    'onUpdate:dirty': (value: boolean) => {
                      formDirty.value = value;
                    },
                  }),
                ],
              }),
            ];
      return h(
        'div',
        { class: 'settings-page', style: { display: props.active ? '' : 'none' } },
        body
      );
    };
  },
});
