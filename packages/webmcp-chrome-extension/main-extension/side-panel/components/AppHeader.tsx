// 顶栏组件：连接状态、工具数量、语言切换（中/EN 分段控件）与设置入口。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP（script-src 'self'）兼容（见 issues/001）。
// 文案经全局 i18n store（t() 直读 locale ref）：切换语言时渲染依赖被追踪，自动重渲染。
import { defineComponent } from 'vue';
import { locale, setLocale, t, type Locale } from '../i18n';

export const AppHeader = defineComponent({
  name: 'AppHeader',
  props: {
    connected: { type: Boolean, required: true },
    toolsCount: { type: Number, required: true },
  },
  emits: {
    // TSX 中 JSX 属性名不支持 kebab-case，emits 用 camelCase 声明（运行时 emit 名称
    // 经 camelize 归一，与旧 kebab-case 事件行为一致）
    toggleSettings: null,
  },
  setup(props, { emit }) {
    /** 语言分段控件的单个选项按钮。 */
    const langOption = (value: Locale, label: string) => (
      <button
        type="button"
        class={{ 'lang-option': true, 'lang-option-active': locale.value === value }}
        title={t('header.langTitle')}
        onClick={() => setLocale(value)}
      >
        {label}
      </button>
    );

    return () => (
      <header class="header">
        <span class={['dot', props.connected ? 'dot-on' : 'dot-off']} />
        <span class="title">{t('header.title')}</span>
        <span class="tools-count">{t('common.toolsCount', { count: String(props.toolsCount) })}</span>
        <span class="lang-toggle" role="group">
          {langOption('zh-CN', '中')}
          {langOption('en-US', 'EN')}
        </span>
        <button class="ghost" type="button" onClick={() => emit('toggleSettings')}>
          {t('header.settings')}
        </button>
      </header>
    );
  },
});
