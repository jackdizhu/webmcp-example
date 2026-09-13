// A2A 绑定列表组件（components/a2a/，P0）：目标智能体绑定关系的「只读卡片」展示 + 行级操作。
// 行级操作（2026-09-13 页面拆分改造）：测试连通（只读探测）/ 编辑（进入单条编辑子页面）/
// 删除（立即生效，整表替换持久化）；新增走「新增绑定」子页面。
// 本组件零 chrome.*，数据经 props/emits（分层约定：独立组件不感知页面路由）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, type PropType, type VNode } from 'vue';
import type { AgentA2aRef } from 'webmcp-agent-chat-core';
import { t } from '../../i18n';

/** 编辑目标智能体的绑定快照（结构对齐 profile 的 a2aAgents 载体）。 */
export interface A2aBindingTargetAgent {
  id: string;
  name: string;
  a2aAgents: AgentA2aRef[];
}

export const A2aBindingList = defineComponent({
  name: 'A2aBindingList',
  props: {
    /** 编辑目标智能体（含其绑定列表；null = 无可展示目标，展示空态）。 */
    agent: { type: Object as PropType<A2aBindingTargetAgent | null>, required: true },
    /** agentId → bearer token（App a2aTokens 响应式快照；只读展示「已配置/未配置」）。 */
    a2aTokens: { type: Object as PropType<Record<string, string>>, required: true },
    /** 连通测试（App 委托 a2a-host.testConnection），返回结果文案。 */
    testConnection: {
      type: Function as PropType<(cardUrl: string, token?: string) => Promise<string>>,
      required: true,
    },
  },
  emits: {
    /** 请求编辑指定绑定（宿主进入单条编辑子页面）。 */
    edit: (id: string) => id.length > 0,
    /** 请求删除指定绑定（宿主整表替换并持久化，立即生效）。 */
    remove: (id: string) => id.length > 0,
  },
  setup(props, { emit }) {
    /** 每条目的连通测试结果（agentId → 文案）。 */
    const testResults = ref<Record<string, string>>({});
    /** 进行中的连通测试 agentId 集合。 */
    const testing = ref<Set<string>>(new Set());

    const handleTest = async (agentId: string, cardUrl: string): Promise<void> => {
      if (testing.value.has(agentId)) return;
      testing.value = new Set([...testing.value, agentId]);
      try {
        const message = await props.testConnection(cardUrl, props.a2aTokens[agentId]);
        testResults.value = { ...testResults.value, [agentId]: message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        testResults.value = { ...testResults.value, [agentId]: t('a2a.testFailed', { message }) };
      } finally {
        const next = new Set(testing.value);
        next.delete(agentId);
        testing.value = next;
      }
    };

    /** 元信息行（只读）：标签 + 值。 */
    const metaRow = (label: string, value: VNode | string): VNode =>
      h('div', { class: 'a2a-item-meta' }, [
        h('span', { class: 'a2a-item-meta-label' }, label),
        h('span', { class: 'a2a-item-meta-value' }, value),
      ]);

    return () => {
      const rows: VNode[] = (props.agent?.a2aAgents ?? []).map((refItem) =>
        h('div', { class: ['a2a-item', refItem.enabled ? '' : 'a2a-item-off'], key: refItem.id }, [
          h('div', { class: 'a2a-item-head' }, [
            h('span', { class: 'a2a-item-id', title: refItem.id }, refItem.id),
            h('span', { class: 'a2a-item-state' }, refItem.enabled ? t('a2a.enabled') : t('a2a.disabled')),
            // 行级操作三件套：测试连通 / 编辑 / 删除（删除立即生效，宿主负责持久化）
            h('button', {
              class: 'ghost',
              type: 'button',
              disabled: testing.value.has(refItem.id),
              onClick: () => void handleTest(refItem.id, refItem.cardUrl),
            }, testing.value.has(refItem.id) ? t('a2a.testing') : t('a2a.testConnection')),
            h('button', {
              class: 'ghost',
              type: 'button',
              onClick: () => emit('edit', refItem.id),
            }, t('a2a.edit')),
            h('button', {
              class: 'ghost',
              type: 'button',
              onClick: () => emit('remove', refItem.id),
            }, t('a2a.remove')),
          ]),
          metaRow(t('a2a.cardUrl'), refItem.cardUrl),
          metaRow(t('a2a.endpointOverride'), refItem.endpointOverride ?? t('a2a.noOverride')),
          metaRow(
            'Token',
            (props.a2aTokens[refItem.id] ?? '').length > 0 ? t('a2a.tokenSet') : t('a2a.tokenUnset')
          ),
          testResults.value[refItem.id]
            ? h('p', { class: 'settings-hint' }, testResults.value[refItem.id]!)
            : null,
        ])
      );

      if (rows.length === 0) {
        return h('p', { class: 'settings-hint' }, t('a2a.noBindings'));
      }
      return h('div', { class: 'a2a-binding-list' }, rows);
    };
  },
});
