// 对话页（页面功能级）：消息列表 + 输入区的组合，承担本页的 Tab 激活态显隐。
// 独立组件（MessageList/Composer）不感知 Tab 语义，显隐收敛在页面层。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, type PropType } from 'vue';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import type { UiMessage } from '../components/types';

export const ChatPage = defineComponent({
  name: 'ChatPage',
  props: {
    messages: { type: Array as PropType<UiMessage[]>, required: true },
    busy: { type: Boolean, required: true },
    /** 对话 Tab 是否激活（非激活时仅隐藏布局，保留滚动位置）。 */
    active: { type: Boolean, required: true },
    /** 输入框内容（v-model 双向绑定到 App）。 */
    modelValue: { type: String, required: true },
  },
  emits: {
    'update:modelValue': (value: string) => typeof value === 'string',
    send: null,
  },
  setup(props, { emit }) {
    return () =>
      h('div', { class: 'chat-page', style: { display: props.active ? '' : 'none' } }, [
        h(MessageList, { messages: props.messages, busy: props.busy }),
        h(Composer, {
          modelValue: props.modelValue,
          busy: props.busy,
          'onUpdate:modelValue': (value: string) => emit('update:modelValue', value),
          onSend: () => emit('send'),
        }),
      ]);
  },
});
