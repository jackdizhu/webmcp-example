// Tab 切换栏：agent 对话 / tools 调试 / relay 调用 / 设置 四个页面入口。
// 执行锁（locked）生效期间：全部入口禁用，仅保留「终止」按钮，避免执行中
// 切换页面造成状态错乱（App 层负责锁的置位与终止动作）。
import { defineComponent, h } from 'vue';

/** 侧栏页面标识。 */
export type PanelPage = 'chat' | 'debug' | 'relay' | 'settings';

/** 页面入口定义（顺序即展示顺序）。 */
const PAGES: Array<{ id: PanelPage; label: string }> = [
  { id: 'chat', label: 'agent 对话' },
  { id: 'debug', label: 'tools 调试' },
  { id: 'relay', label: 'relay 调用' },
  { id: 'settings', label: '设置' },
];

export const TabBar = defineComponent({
  name: 'TabBar',
  props: {
    activeTab: { type: String as () => PanelPage, required: true },
    /** 执行锁：agent 对话或 relay 调用进行中为 true（禁止切换页面）。 */
    locked: { type: Boolean, required: true },
    /** 锁定期间展示的执行提示（如「agent 对话执行中」）。 */
    phaseLabel: { type: String, default: '' },
  },
  emits: {
    'update:activeTab': (value: PanelPage) => PAGES.some((page) => page.id === value),
    /** 用户点击「终止」。 */
    abort: null,
  },
  setup(props, { emit }) {
    const tabButton = (page: { id: PanelPage; label: string }) =>
      h(
        'button',
        {
          type: 'button',
          class: { 'tab-active': props.activeTab === page.id },
          disabled: props.locked,
          onClick: () => emit('update:activeTab', page.id),
        },
        page.label
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
                '终止'
              ),
            ])
          : null,
      ]);
  },
});
