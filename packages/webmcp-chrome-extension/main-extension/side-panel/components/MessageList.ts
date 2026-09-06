// 消息列表：用户/助手气泡、工具执行痕迹、空态与处理中提示。
// 滚动逻辑内聚：深度监听消息数组（含工具痕迹回填）与 busy，自动滚到底部。
import { defineComponent, h, nextTick, ref, watch, type PropType } from 'vue';
import type { UiMessage } from './types';

export const MessageList = defineComponent({
  name: 'MessageList',
  props: {
    messages: { type: Array as PropType<UiMessage[]>, required: true },
    busy: { type: Boolean, required: true },
  },
  setup(props) {
    const messagesEl = ref<HTMLElement | null>(null);

    const scrollToBottom = (): void => {
      void nextTick(() => {
        messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight });
      });
    };

    // 消息内容、工具痕迹、busy 状态任一变化都触发滚动（与拆分前 scrollToEnd 行为一致）
    watch(() => [props.messages, props.busy] as const, scrollToBottom, { deep: true });

    return () =>
      h(
        'main',
        {
          ref: messagesEl,
          class: 'messages',
        },
        [
          props.messages.length === 0
            ? h('div', { class: 'empty' }, [
                h('p', '两种方式验证页面的 WebMCP 工具：'),
                h('p', '对话 —— 与 agent 对话来发现并调用页面工具（需在「设置」中配置 API Key）；'),
                h('p', '调试 —— 不经 LLM 手动执行工具并查看结果（无需 Key，入口在「设置」面板）。'),
                h('p', '例如："列出页面工具，并逐个调用验证返回"。'),
              ])
            : null,
          ...props.messages.map((message, index) =>
            h('div', { class: ['msg', `msg-${message.role}`], key: index }, [
              h('div', { class: 'bubble' }, [
                message.content ? h('p', { class: 'content' }, message.content) : null,
                ...message.toolTrace.map((trace, traceIndex) =>
                  h('div', { class: ['tool', trace.failed ? 'tool-failed' : ''], key: traceIndex }, [
                    h('span', { class: 'tool-name' }, trace.name),
                    h('pre', { class: 'tool-result' }, trace.result),
                  ])
                ),
              ]),
            ])
          ),
          props.busy ? h('p', { class: 'busy' }, 'agent 处理中…') : null,
        ]
      );
  },
});
