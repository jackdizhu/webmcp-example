// 对话页（页面功能级）：顶部栏（智能体选择）+ 左侧栏（新建会话 + 会话列表）+
// 右侧会话窗口 + 底部输入区 的四区布局，承担本页的 Tab 激活态显隐。
// 独立组件（MessageList/Composer/SessionList）不感知 Tab 语义，显隐收敛在页面层。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
// 智能体切换语义（2026-09-18 布局调整）：选择器只发出请求，App 层自动归档当前会话
// 并开新会话（无确认流程）；本页不渲染切换确认条。
import { defineComponent, type PropType } from 'vue';
import { t } from '../i18n';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import { SessionList } from '../components/SessionList';
import type { UiMessage } from '../components/types';
import type { StoredChatSession } from '../sessions/session-core';

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
    /** 可选智能体列表（顶部选择器与会话列表名称反查共用）。 */
    agents: { type: Array as PropType<AgentOption[]>, required: true },
    /** 当前激活智能体 ID。 */
    activeAgentId: { type: String, required: true },
    /** 当前会话是否有消息（空会话时「新会话」按钮禁用，无归档价值）。 */
    hasMessages: { type: Boolean, required: true },
    /** 最近会话快照（左侧栏列表数据源，App 已按 sessionLoadLimit 裁剪）。 */
    recentSessions: { type: Array as PropType<StoredChatSession[]>, default: () => [] },
  },
  emits: {
    'update:modelValue': (value: string) => typeof value === 'string',
    send: null,
    // TSX 中 JSX 属性名不支持 kebab-case，emits 用 camelCase 声明（运行时 emit 名称
    // 经 camelize 归一，与旧 kebab-case 事件行为一致）
    /** 请求切换到指定智能体（App 层负责 locked 守卫、归档当前会话并自动开新会话）。 */
    switchAgent: (id: string) => typeof id === 'string',
    /** 请求新建会话（App 层负责归档当前会话与清空）。 */
    newSession: null,
    /** 请求恢复指定会话（App 层执行）。 */
    restoreSession: (session: StoredChatSession) => Boolean(session),
  },
  setup(props, { emit }) {
    return () => (
      <div class="chat-page" style={{ display: props.active ? '' : 'none' }}>
        {/* 顶部栏：智能体选择（切换即自动开新会话，语义在 App 层） */}
        <div class="chat-topbar">
          <span class="chat-agents-label">{t('chat.agentLabel')}</span>
          <select
            class="chat-agents-select"
            disabled={props.locked}
            onChange={(event: Event) => {
              emit('switchAgent', (event.target as HTMLSelectElement).value);
            }}
          >
            {props.agents.map((item) => (
              <option
                value={item.id}
                // 用 option.selected（而非 select.value 属性）保证挂载与更新时的选中态
                selected={item.id === props.activeAgentId}
              >
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div class="chat-body">
          {/* 左侧栏：新建会话 + 最近会话列表（常驻，不再限于空态展示） */}
          <aside class="chat-sidebar">
            <button
              class="ghost chat-sidebar-new"
              disabled={props.locked || !props.hasMessages}
              title={t('chat.newSession')}
              onClick={() => emit('newSession')}
            >
              {t('chat.newSession')}
            </button>
            <SessionList
              sessions={props.recentSessions}
              agents={props.agents}
              locked={props.locked}
              onRestore={(session: StoredChatSession) => emit('restoreSession', session)}
            />
          </aside>
          {/* 右侧区域：会话窗口 */}
          <div class="chat-main">
            <MessageList messages={props.messages} busy={props.busy} />
          </div>
        </div>
        {/* 底部栏：输入区域 + 发送按钮 */}
        <Composer
          modelValue={props.modelValue}
          busy={props.busy || props.locked}
          onUpdate:modelValue={(value: string) => emit('update:modelValue', value)}
          onSend={() => emit('send')}
        />
      </div>
    );
  },
});
