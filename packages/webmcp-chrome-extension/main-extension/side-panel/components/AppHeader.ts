// 顶栏组件：连接状态、工具数量与设置入口。
// 模板必须用 h() 渲染函数：MV3 扩展页 CSP 禁止运行时字符串编译（见 issues/001）。
import { defineComponent, h } from 'vue';

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
    return () =>
      h('header', { class: 'header' }, [
        h('span', { class: ['dot', props.connected ? 'dot-on' : 'dot-off'] }),
        h('span', { class: 'title' }, 'WebMCP 页面工具助手'),
        h('span', { class: 'tools-count' }, `${props.toolsCount} 个工具`),
        h(
          'button',
          { class: 'ghost', type: 'button', onClick: () => emit('toggle-settings') },
          '设置'
        ),
      ]);
  },
});
