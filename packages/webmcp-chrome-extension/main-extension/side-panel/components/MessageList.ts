// 消息列表：用户/助手气泡、工具/技能执行痕迹（默认收起、点击展开）、空态与处理中提示。
// 滚动逻辑内聚：深度监听消息数组（含工具痕迹回填）与 busy，自动滚到底部。
// 文案经全局 i18n store（t() 直读 locale ref），切换语言自动重渲染。
// 注意：types.ts 的 TOOL_PENDING_TEXT 是「待回填」哨兵值（App 按其匹配回填），非展示文案；
// 展示层统一用 t('chat.tracePending')。
import { defineComponent, h, nextTick, ref, watch, type PropType } from 'vue';
import { t } from '../i18n';
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
              h(
                'span',
                { class: 'tool-toggle' },
                pending
                  ? t('chat.tracePending')
                  : expanded.value
                    ? t('chat.traceCollapse')
                    : t('chat.traceExpand')
              ),
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
                h('p', t('chat.emptyTitle')),
                h('p', t('chat.emptyChat')),
                h('p', t('chat.emptyDebug')),
                h('p', t('chat.emptyExample')),
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
          props.busy ? h('p', { class: 'busy' }, t('chat.pending')) : null,
        ]
      );
  },
});
