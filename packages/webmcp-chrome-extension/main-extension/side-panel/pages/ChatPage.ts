// 对话页（页面功能级）：智能体选择器 + 消息列表 + 输入区的组合，承担本页的 Tab 激活态显隐。
// 独立组件（MessageList/Composer）不感知 Tab 语义，显隐收敛在页面层。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
// 智能体切换语义（D4）：选择器只发出请求，确认流由 App 层守卫与执行；
// 本页仅渲染「确认切换」提示条（pendingSwitchName 非空时显示）。
import { defineComponent, h, type PropType } from 'vue';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import type { UiMessage } from '../components/types';

/** 选择器选项（由 App 从 profileStore 映射，页面不感知 Profile 完整模型）。 */
export interface AgentOption {
  id: string;
  name: string;
}

export const ChatPage = defineComponent({
  name: 'ChatPage',
  props: {
    messages: { type: Array as PropType<UiMessage[]>, required: true },
    busy: { type: Boolean, required: true },
    /**
     * 执行锁（agent 对话或 relay 调用进行中）：输入与发送禁用。
     * 消息列表的「处理中」提示仍由 busy 驱动（relay 调用执行中不误导）。
     */
    locked: { type: Boolean, required: true },
    /** 对话页是否激活（非激活时仅隐藏布局，保留滚动位置）。 */
    active: { type: Boolean, required: true },
    /** 输入框内容（v-model 双向绑定到 App）。 */
    modelValue: { type: String, required: true },
    /** 可选智能体列表（选择器渲染）。 */
    agents: { type: Array as PropType<AgentOption[]>, required: true },
    /** 当前激活智能体 ID。 */
    activeAgentId: { type: String, required: true },
    /** 待确认切换的智能体名（空串 = 无待确认，隐藏确认条）。 */
    pendingSwitchName: { type: String, required: true },
  },
  emits: {
    'update:modelValue': (value: string) => typeof value === 'string',
    send: null,
    /** 请求切换到指定智能体（App 层负责 locked 守卫与确认流）。 */
    'switch-agent': (id: string) => typeof id === 'string',
    'confirm-switch': null,
    'cancel-switch': null,
    /** 请求查看最终组装的系统提示词（App 层组装后以消息展示）。 */
    'inspect-prompt': null,
  },
  setup(props, { emit }) {
    return () =>
      h('div', { class: 'chat-page', style: { display: props.active ? '' : 'none' } }, [
        h('div', { class: 'chat-agents' }, [
          h('span', { class: 'chat-agents-label' }, '智能体'),
          h(
            'select',
            {
              class: 'chat-agents-select',
              disabled: props.locked || props.pendingSwitchName.length > 0,
              onChange: (event: Event) => {
                emit('switch-agent', (event.target as HTMLSelectElement).value);
              },
            },
            props.agents.map((item) =>
              h(
                'option',
                {
                  value: item.id,
                  // 用 option.selected（而非 select.value 属性）保证挂载与更新时的选中态
                  selected: item.id === props.activeAgentId,
                },
                item.name
              )
            )
          ),
          h(
            'button',
            {
              class: 'ghost chat-agents-inspect',
              disabled: props.locked,
              onClick: () => emit('inspect-prompt'),
            },
            '查看提示词'
          ),
        ]),
        props.pendingSwitchName.length > 0
          ? h('div', { class: 'chat-agent-confirm' }, [
              h(
                'span',
                { class: 'chat-agent-confirm-text' },
                `切换到「${props.pendingSwitchName}」将开启新会话，当前对话历史将被清空。`
              ),
              h(
                'button',
                { class: 'chat-agent-confirm-btn', onClick: () => emit('confirm-switch') },
                '确认切换'
              ),
              h(
                'button',
                { class: 'ghost chat-agent-confirm-cancel', onClick: () => emit('cancel-switch') },
                '取消'
              ),
            ])
          : null,
        h(MessageList, { messages: props.messages, busy: props.busy }),
        h(Composer, {
          modelValue: props.modelValue,
          busy: props.busy || props.locked,
          'onUpdate:modelValue': (value: string) => emit('update:modelValue', value),
          onSend: () => emit('send'),
        }),
      ]);
  },
});
