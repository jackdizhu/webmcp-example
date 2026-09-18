// 最近会话列表：对话页左侧栏常驻展示（App 已按 sessionLoadLimit 裁剪条数），点击条目恢复会话。
// 纯展示组件：只消费 props 快照与 agents 名称映射，相对时间为展示层格式化。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { defineComponent, type PropType } from 'vue';
import { t } from '../i18n';
import type { StoredChatSession } from '../sessions/session-core';

/** 智能体选择项（与 ChatPage.AgentOption 同构；本组件只反查展示名）。 */
interface AgentOption {
  id: string;
  name: string;
}

/** 相对时间文案：刚刚 / N 分钟前 / N 小时前 / N 天前；超过一周回落到本地日期。 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return t('chat.timeJustNow');
  if (minutes < 60) return t('chat.timeMinutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('chat.timeHoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('chat.timeDaysAgo', { n: days });
  return new Date(ts).toLocaleDateString();
}

export const SessionList = defineComponent({
  name: 'SessionList',
  props: {
    /** 最近会话快照（App 已按 updatedAt 降序 + sessionLoadLimit 截取）。 */
    sessions: { type: Array as PropType<StoredChatSession[]>, required: true },
    /** 智能体名称映射（agentId → 展示名；未命中回落 agentId）。 */
    agents: { type: Array as PropType<AgentOption[]>, required: true },
    /** 执行锁（agent 对话 / relay 调用进行中）：条目不可点击。 */
    locked: { type: Boolean, required: true },
  },
  emits: {
    /** 请求恢复指定会话（App 层负责保存当前会话与上下文回灌）。 */
    restore: (session: StoredChatSession) => Boolean(session),
  },
  setup(props, { emit }) {
    const agentName = (id: string): string =>
      props.agents.find((item) => item.id === id)?.name ?? id;

    return () => (
      <div class="session-list">
        <p class="session-list-title">{t('chat.recentSessions')}</p>
        {props.sessions.length === 0 ? (
          <p class="session-list-empty">{t('chat.sessionEmpty')}</p>
        ) : (
          <ul class="session-list-items">
            {props.sessions.map((session) => (
              <li key={session.id}>
                <button
                  class="session-item"
                  type="button"
                  disabled={props.locked}
                  title={session.title}
                  onClick={() => emit('restore', session)}
                >
                  <span class="session-item-title">{session.title}</span>
                  {session.origin !== undefined || session.taskStatus !== undefined ? (
                    <span class="session-item-badges">
                      {session.origin !== undefined ? (
                        <span
                          class="session-item-badge session-item-badge-origin"
                          title={session.origin}
                        >
                          {t('chat.taskBadge')}
                        </span>
                      ) : null}
                      {session.taskStatus !== undefined ? (
                        <span class={`session-item-badge session-item-status-${session.taskStatus}`}>
                          {t(`chat.taskStatus.${session.taskStatus}`)}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  <span class="session-item-meta">
                    {t('chat.sessionMeta', {
                      agent: agentName(session.agentId),
                      count: session.messages.length,
                      time: relativeTime(session.updatedAt),
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
});
