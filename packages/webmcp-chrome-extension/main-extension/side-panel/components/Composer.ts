// 输入区：文本域（回车发送 / Shift+Enter 换行）与发送按钮。
// 输入值经 v-model 双向绑定到 App（update:modelValue），发送动作回抛 send 事件。
import { defineComponent, h } from 'vue';

export const Composer = defineComponent({
  name: 'Composer',
  props: {
    modelValue: { type: String, required: true },
    busy: { type: Boolean, required: true },
  },
  emits: {
    'update:modelValue': (value: string) => typeof value === 'string',
    send: null,
  },
  setup(props, { emit }) {
    return () =>
      h('footer', { class: 'composer' }, [
        h('textarea', {
          rows: 2,
          placeholder: '例如：列出页面工具并调用 get_status 验证返回',
          disabled: props.busy,
          value: props.modelValue,
          onInput: (event: Event) => {
            emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
          },
          // 等价模板 @keydown.enter.exact.prevent：仅回车（无修饰键）发送，Shift+Enter 换行
          onKeydown: (event: KeyboardEvent) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              emit('send');
            }
          },
        }),
        h(
          'button',
          {
            type: 'button',
            disabled: props.busy || props.modelValue.trim().length === 0,
            onClick: () => emit('send'),
          },
          '发送'
        ),
      ]);
  },
});
