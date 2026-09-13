// 远程智能体（A2A）管理区块（components/，P0）—— 列表页 + 独立子页面（2026-09-13 页面拆分改造）。
//
// 页面形态（取代旧「查看/整块编辑」双模式）：
// - list（默认）→ 只读卡片列表（行级操作：测试连通 / 编辑 / 删除）+「新增绑定」入口
//   + 编辑目标选择器（查看态可切换管理不同智能体的绑定，带目标标注提示）
// - add → SubPageFrame「新增绑定」子页面（返回 icon 回列表；提交即落库）
// - edit → SubPageFrame「编辑绑定 · <id>」子页面（cardUrl/端点覆盖/token/启停；落库即返回）
// 两个子页面复用同一 A2aBindingForm（mode: 'add' | 'edit'，2026-09-13 统一），
// 提交统一走 handleFormSubmit upsert（存在 = 单条替换，不存在 = 追加）。
// 数据归属：a2aAgents 持久化在 profile（经 App 落 profileStore）；token 持久化在
// chrome.storage.local 的 a2aTokens（经 App 落 a2a-host）——本组件零 chrome.*，
// 全部经 props/emits/函数 prop 与宿主交互（分层约定：独立组件不感知页面路由）。
// 决策（2026-09-12）：agentKey（id）一经创建不可变，UI 不提供 id 编辑（改 URL 不改名）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, type PropType } from 'vue';
import type { AgentA2aRef } from 'webmcp-agent-chat-core';
import { t } from '../i18n';
import { SubPageFrame } from './SubPageFrame';
import { A2aBindingForm, type A2aFormPayload } from './a2a/A2aBindingForm';
import { A2aBindingList, type A2aBindingTargetAgent } from './a2a/A2aBindingList';

export const A2aAgentsSection = defineComponent({
  name: 'A2aAgentsSection',
  props: {
    /** 全部智能体档案（编辑目标经 targetAgentId 选择）。 */
    agents: { type: Array as PropType<Array<{ id: string; name: string; a2aAgents: AgentA2aRef[] }>>, required: true },
    activeAgentId: { type: String, required: true },
    /** 当前编辑目标智能体 id（默认跟随激活，可手动切换；绑定按目标分别持久化）。 */
    targetAgentId: { type: String, required: true },
    /** agentId → bearer token（App 从 a2aTokens 存储加载的响应式快照）。 */
    a2aTokens: { type: Object as PropType<Record<string, string>>, required: true },
    busy: { type: Boolean, required: true },
    /** 连通测试（App 委托 a2a-host.testConnection），返回结果文案。 */
    testConnection: {
      type: Function as PropType<(cardUrl: string, token?: string) => Promise<string>>,
      required: true,
    },
    /** App 层全局提示（持久化失败等；null = 无提示）。 */
    notice: {
      type: Object as PropType<{ kind: 'error' | 'ok'; text: string } | null>,
      default: null,
    },
  },
  emits: {
    /** 切换编辑目标智能体。 */
    'update:targetAgentId': (id: string) => id.length > 0,
    /** 整表替换目标智能体的 a2aAgents。 */
    'update:a2aAgents': (refs: AgentA2aRef[]) => Array.isArray(refs),
    /** 保存单条 token（agentId 可为尚未添加的待新增 id）。 */
    'save:token': (agentId: string, _token: string) => agentId.length > 0,
  },
  setup(props, { emit }) {
    /** 页面形态：list = 只读列表；add/edit = 独立子页面（跨页签切换保留）。 */
    const view = ref<'list' | 'add' | 'edit'>('list');
    /** 编辑态目标条目 id（view === 'edit' 时有效）。 */
    const editingId = ref('');

    /** 当前编辑目标智能体（按 targetAgentId 查找；不存在 = null，由 UI 提示）。 */
    const targetAgent = (): A2aBindingTargetAgent | null =>
      props.agents.find((agent) => agent.id === props.targetAgentId) ?? null;

    // ---- 列表页动作（删除立即落库；编辑/新增进入子页面）----

    const handleRemove = (id: string): void => {
      const agent = targetAgent();
      if (agent === null) return;
      emit('update:a2aAgents', agent.a2aAgents.filter((item) => item.id !== id));
    };

    const openEdit = (id: string): void => {
      editingId.value = id;
      view.value = 'edit';
    };

    const backToList = (): void => {
      view.value = 'list';
      editingId.value = '';
    };

    // ---- 表单子页面提交（新增/编辑统一 upsert + 按需保存 token，立即落库）----

    const handleFormSubmit = (payload: A2aFormPayload): void => {
      const agent = targetAgent();
      if (agent === null) return;
      // 归一化端点覆盖（空串 = 字段移除语义，回落卡片接口地址）
      const trimmed = payload.endpointOverride.trim();
      const base = { id: payload.id, cardUrl: payload.cardUrl, enabled: payload.enabled };
      const refItem: AgentA2aRef = trimmed.length > 0 ? { ...base, endpointOverride: trimmed } : base;
      const exists = agent.a2aAgents.some((item) => item.id === payload.id);
      emit(
        'update:a2aAgents',
        exists
          ? agent.a2aAgents.map((item) => (item.id === payload.id ? refItem : item))
          : [...agent.a2aAgents, refItem]
      );
      if (exists) {
        // 编辑：token 有变化才保存（含清空为空串）
        if ((props.a2aTokens[payload.id] ?? '') !== payload.token) {
          emit('save:token', payload.id, payload.token);
        }
      } else if (payload.token.length > 0) {
        // 新增：非空 token 才保存
        emit('save:token', payload.id, payload.token);
      }
      backToList();
    };

    return () => {
      const agent = targetAgent();
      // A8：全局 notice 升级为卡片（边框 + 左缘状态条），失败/成功视觉分级
      const noticeNode =
        props.notice !== null
          ? h(
              'p',
              {
                class:
                  props.notice.kind === 'error'
                    ? 'settings-notice settings-notice-error'
                    : 'settings-notice settings-notice-ok',
              },
              props.notice.text
            )
          : null;

      // ---- 新增子页面（独立页面：返回 icon + 标题栏）----
      if (view.value === 'add') {
        return h('div', { class: 'settings-a2a' }, [
          h(SubPageFrame, { title: t('a2a.add.title'), onBack: () => backToList() }, {
            default: () => [
              noticeNode,
              agent === null
                ? h('p', { class: 'settings-hint' }, t('a2a.noEditableAgent'))
                : h(A2aBindingForm, {
                    mode: 'add',
                    targetAgent: agent,
                    busy: props.busy,
                    onSubmit: (payload: A2aFormPayload) => handleFormSubmit(payload),
                  }),
            ],
          }),
        ]);
      }

      // ---- 编辑子页面（单条：返回 icon + 标题栏）----
      if (view.value === 'edit') {
        const editingItem = agent?.a2aAgents.find((item) => item.id === editingId.value) ?? null;
        return h('div', { class: 'settings-a2a' }, [
          h(
            SubPageFrame,
            { title: t('a2a.editItemTitle', { id: editingId.value }), onBack: () => backToList() },
            {
              default: () => [
                noticeNode,
                agent === null || editingItem === null
                  ? h('p', { class: 'settings-hint' }, t('a2a.noEditableAgent'))
                  : h(A2aBindingForm, {
                      mode: 'edit',
                      item: editingItem,
                      token: props.a2aTokens[editingItem.id] ?? '',
                      busy: props.busy,
                      onSubmit: (payload: A2aFormPayload) => handleFormSubmit(payload),
                      onCancel: () => backToList(),
                    }),
              ],
            }
          ),
        ]);
      }

      // ---- 列表页（默认：只读卡片 + 行级操作 + 新增入口 + 目标选择器）----
      // A1 目标工具条：mono 标签 + 目标选择器 + 当前目标徽章（非激活警示收敛为徽章 title 悬停提示）
      const targetBadge =
        agent !== null
          ? h(
              'span',
              {
                class:
                  props.targetAgentId !== props.activeAgentId
                    ? 'relay-badge relay-badge-reconnecting'
                    : 'relay-badge',
                title:
                  props.targetAgentId !== props.activeAgentId
                    ? t('a2a.viewTargetNotActive')
                    : undefined,
              },
              t('a2a.targetShowing', { name: agent.name })
            )
          : null;
      return h('div', { class: 'settings-a2a' }, [
        h('div', { class: 'a2a-target-bar' }, [
          h('label', { class: 'a2a-target-label', for: 'a2a-target-agent' }, t('a2a.editTarget')),
          h(
            'select',
            {
              class: 'a2a-target-select',
              id: 'a2a-target-agent',
              value: props.targetAgentId,
              onChange: (event: Event) => {
                emit('update:targetAgentId', (event.target as HTMLSelectElement).value);
              },
            },
            props.agents.map((item) =>
              h(
                'option',
                { value: item.id, key: item.id },
                item.id === props.activeAgentId
                  ? t('a2a.targetActive', { name: item.name })
                  : item.name
              )
            )
          ),
          targetBadge,
        ]),
        h('p', { class: 'settings-hint' }, t('a2a.hint')),
        noticeNode,
        agent === null
          ? h('p', { class: 'settings-hint' }, t('a2a.noEditableAgent'))
          : h(A2aBindingList, {
              agent,
              a2aTokens: props.a2aTokens,
              testConnection: props.testConnection,
              onEdit: (id: string) => openEdit(id),
              onRemove: (id: string) => handleRemove(id),
              // A6 空态 CTA：从列表页直接进入新增子页面
              onAdd: () => {
                view.value = 'add';
              },
            }),
        h('div', { class: 'page-mode-actions' }, [
          h('button', {
            type: 'button',
            disabled: props.busy || agent === null,
            onClick: () => {
              view.value = 'add';
            },
          }, t('a2a.add.title')),
        ]),
      ]);
    };
  },
});
