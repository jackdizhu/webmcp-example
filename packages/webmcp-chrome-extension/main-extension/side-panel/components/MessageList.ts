// 消息列表：用户/助手气泡、工具/技能执行痕迹（默认收起、点击展开）、空态与处理中提示。
// 滚动逻辑内聚：深度监听消息数组（含工具痕迹回填）与 busy，自动滚到底部。
import { defineComponent, h, nextTick, ref, watch, type PropType } from 'vue';
import { TOOL_PENDING_TEXT, type ToolTraceItem, type UiMessage } from './types';

/** 单条痕迹的折叠行：头部（徽标 + 名称 + 展开态）默认收起，点击头部切换；执行中不可展开。 */
const TraceItem = defineComponent({
  name: 'TraceItem',
  props: {
    trace: { type: Object as PropType<ToolTraceItem>, required: true },
  },
  setup(props) {
    const expanded = ref(false);
    const toggle = (): void => {
      if (props.trace.result === TOOL_PENDING_TEXT) return;
      expanded.value = !expanded.value;
    };
    return () => {
      const pending = props.trace.result === TOOL_PENDING_TEXT;
      // 展示类别：tool（缺省）/ skill / a2a —— 后两者有专属徽标文案、配色与展示名
      const kind = props.trace.kind ?? 'tool';
      return h(
        'div',
        { class: ['tool', props.trace.failed ? 'tool-failed' : '', kind !== 'tool' ? `tool-${kind}` : ''] },
        [
          h(
            'div',
            { class: 'tool-head', style: { cursor: pending ? 'default' : 'pointer' }, onClick: toggle },
            [
              h(
                'span',
                { class: ['tool-badge', kind !== 'tool' ? `tool-badge-${kind}` : ''] },
                kind === 'tool' ? 'TOOL' : kind.toUpperCase()
              ),
              // SKILL 行展示技能 id、A2A 行展示远端智能体 id（label 由 App 回填），
              // 普通工具行展示工具名
              h('span', { class: 'tool-name' }, props.trace.label ?? props.trace.name),
              h('span', { class: 'tool-toggle' }, pending ? '执行中…' : expanded.value ? '收起 ▲' : '展开 ▼'),
            ]
          ),
          expanded.value ? h('pre', { class: 'tool-result' }, props.trace.result) : null,
        ]
      );
    };
  },
});

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
                  h(TraceItem, { trace, key: traceIndex })
                ),
              ]),
            ])
          ),
          props.busy ? h('p', { class: 'busy' }, 'agent 处理中…') : null,
        ]
      );
  },
});
