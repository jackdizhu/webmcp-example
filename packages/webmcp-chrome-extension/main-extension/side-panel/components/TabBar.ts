// Tab 切换栏：对话 / 调试（仅 debugMode 开启时渲染）。
import { defineComponent, h } from 'vue';

export const TabBar = defineComponent({
  name: 'TabBar',
  props: {
    activeTab: { type: String as () => 'chat' | 'debug', required: true },
  },
  emits: {
    'update:activeTab': (value: 'chat' | 'debug') => value === 'chat' || value === 'debug',
  },
  setup(props, { emit }) {
    const tabButton = (target: 'chat' | 'debug', label: string) =>
      h(
        'button',
        {
          type: 'button',
          class: { 'tab-active': props.activeTab === target },
          onClick: () => emit('update:activeTab', target),
        },
        label
      );

    return () =>
      h('nav', { class: 'tabs' }, [tabButton('chat', '对话'), tabButton('debug', '调试')]);
  },
});
