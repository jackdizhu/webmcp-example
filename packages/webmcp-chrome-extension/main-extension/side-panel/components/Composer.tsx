// 输入区：文本域（回车发送 / Shift+Enter 换行）与发送按钮。
// 输入值经 v-model 双向绑定到 App（update:modelValue），发送动作回抛 send 事件。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
// 文案经全局 i18n store（t() 直读 locale ref），切换语言自动重渲染。
import { defineComponent } from 'vue';
import { t } from '../i18n';

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
    return () => (
      <footer class="composer">
        <textarea
          rows={2}
          placeholder={t('chat.composerPlaceholder')}
          disabled={props.busy}
          value={props.modelValue}
          onInput={(event: Event) => {
            emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
          }}
          // 等价模板 @keydown.enter.exact.prevent：仅回车（无修饰键）发送，Shift+Enter 换行
          onKeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              emit('send');
            }
          }}
        />
        <button
          type="button"
          disabled={props.busy || props.modelValue.trim().length === 0}
          onClick={() => emit('send')}
        >
          {t('chat.send')}
        </button>
      </footer>
    );
  },
});
