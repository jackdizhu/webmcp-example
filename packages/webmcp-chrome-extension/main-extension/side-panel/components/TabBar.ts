// Tab 切换栏：agent 对话 / tools 调试 / relay 调用 / 数据源设置 / 远程智能体（A2A） / 设置 六个页面入口。
// 页签较多：容器横向滚动（.tabs overflow-x，见 side-panel.html），按钮不收缩换行。
// 执行锁（locked）生效期间：全部入口禁用，仅保留「终止」按钮，避免执行中
// 切换页面造成状态错乱（App 层负责锁的置位与终止动作）。
// 文案经全局 i18n store（t() 直读 locale ref），切换语言自动重渲染。
import { defineComponent, h } from 'vue';
import { t } from '../i18n';
import type { MessageKey } from '../i18n/zh-CN';

/** 侧栏页面标识。 */
export type PanelPage = 'chat' | 'debug' | 'relay' | 'datasource' | 'a2a' | 'settings';

/** 页面入口定义（顺序即展示顺序；label 为 i18n 键）。 */
const PAGES: Array<{ id: PanelPage; labelKey: MessageKey }> = [
  { id: 'chat', labelKey: 'tab.chat' },
  { id: 'debug', labelKey: 'tab.debug' },
  { id: 'relay', labelKey: 'tab.relay' },
  { id: 'datasource', labelKey: 'tab.datasource' },
  { id: 'a2a', labelKey: 'tab.a2a' },
  { id: 'settings', labelKey: 'tab.settings' },
];

export const TabBar = defineComponent({
  name: 'TabBar',
  props: {
    activeTab: { type: String as () => PanelPage, required: true },
    /** 执行锁：agent 对话或 relay 调用进行中为 true（禁止切换页面）。 */
    locked: { type: Boolean, required: true },
    /** 锁定期间展示的执行提示（如「agent 对话执行中」，App 层已过 t()）。 */
    phaseLabel: { type: String, default: '' },
  },
  emits: {
    'update:activeTab': (value: PanelPage) => PAGES.some((page) => page.id === value),
    /** 用户点击「终止」。 */
    abort: null,
  },
  setup(props, { emit }) {
    const tabButton = (page: { id: PanelPage; labelKey: MessageKey }) =>
      h(
        'button',
        {
          type: 'button',
          class: { 'tab-active': props.activeTab === page.id },
          disabled: props.locked,
          onClick: () => emit('update:activeTab', page.id),
        },
        t(page.labelKey)
      );

    return () =>
      h('nav', { class: ['tabs', props.locked ? 'tabs-locked' : ''] }, [
        ...PAGES.map(tabButton),
        props.locked
          ? h('span', { class: 'tabs-lock-area' }, [
              h('span', { class: 'tabs-lock-label' }, props.phaseLabel),
              h(
                'button',
                { class: 'tabs-abort', type: 'button', onClick: () => emit('abort') },
                t('tab.abort')
              ),
            ])
          : null,
      ]);
  },
});
