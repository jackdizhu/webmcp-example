// 顶栏组件：连接状态、工具数量、语言切换（中/EN 分段控件）与设置入口。
// 模板必须用 h() 渲染函数：MV3 扩展页 CSP 禁止运行时字符串编译（见 issues/001）。
// 文案经全局 i18n store（t() 直读 locale ref）：切换语言时渲染依赖被追踪，自动重渲染。
import { defineComponent, h } from 'vue';
import { locale, setLocale, t, type Locale } from '../i18n';

export const AppHeader = defineComponent({
  name: 'AppHeader',
  props: {
    connected: { type: Boolean, required: true },
    toolsCount: { type: Number, required: true },
  },
  emits: {
    'toggle-settings': null,
  },
  setup(props, { emit }) {
    /** 语言分段控件的单个选项按钮。 */
    const langOption = (value: Locale, label: string) =>
      h(
        'button',
        {
          type: 'button',
          class: { 'lang-option': true, 'lang-option-active': locale.value === value },
          title: t('header.langTitle'),
          onClick: () => setLocale(value),
        },
        label
      );

    return () =>
      h('header', { class: 'header' }, [
        h('span', { class: ['dot', props.connected ? 'dot-on' : 'dot-off'] }),
        h('span', { class: 'title' }, t('header.title')),
        h('span', { class: 'tools-count' }, t('common.toolsCount', { count: String(props.toolsCount) })),
        h('span', { class: 'lang-toggle', role: 'group' }, [
          langOption('zh-CN', '中'),
          langOption('en-US', 'EN'),
        ]),
        h(
          'button',
          { class: 'ghost', type: 'button', onClick: () => emit('toggle-settings') },
          t('header.settings')
        ),
      ]);
  },
});
