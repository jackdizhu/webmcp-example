// A2A 绑定列表组件（components/a2a/，P0）：目标智能体绑定关系的「只读卡片」展示 + 行级操作。
// 行级操作（2026-09-13 页面拆分改造）：测试连通（只读探测）/ 编辑（进入单条编辑子页面）/
// 删除（两步确认后生效，整表替换持久化）；新增走「新增绑定」子页面（空态内嵌 CTA，emit('add')）。
// 页内 UI 优化（2026-09-13 方案二 A2-A6）：
// - A2 卡片头只留 id + 状态徽章，操作独立成行 .a2a-item-actions（消除 320px 溢出）
// - A3 删除钮 danger-ghost 红描边 + 两步确认（3s 超时还原，页内 inline 无弹窗）
// - A4 meta 徽章化：未覆盖/Token 状态用 .a2a-meta-badge，URL 值单行省略 + title 悬停看全量
// - A5 测试结果分级 .a2a-test-result-ok/-err（左缘状态条 + 色字）
// - A6 空态 .page-empty + 内嵌「新增绑定」CTA
// 本组件零 chrome.*，数据经 props/emits（分层约定：独立组件不感知页面路由）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, onUnmounted, ref, type PropType, type VNode } from 'vue';
import type { AgentA2aRef } from 'webmcp-agent-chat-core';
import { t } from '../../i18n';

/** 编辑目标智能体的绑定快照（结构对齐 profile 的 a2aAgents 载体）。 */
export interface A2aBindingTargetAgent {
  id: string;
  name: string;
  a2aAgents: AgentA2aRef[];
}

/** 单条连通测试结果（kind 决定视觉分级：ok = 成功绿 / err = 失败红）。 */
interface TestResult {
  kind: 'ok' | 'err';
  text: string;
}

/** 两步确认持续时间（ms）：超时未二次点击自动还原。 */
const CONFIRM_TIMEOUT_MS = 3000;

export const A2aBindingList = defineComponent({
  name: 'A2aBindingList',
  props: {
    /** 编辑目标智能体（含其绑定列表；null = 无可展示目标，展示空态）。 */
    agent: { type: Object as PropType<A2aBindingTargetAgent | null>, required: true },
    /** agentId → bearer token（App a2aTokens 响应式快照；只读展示徽章）。 */
    a2aTokens: { type: Object as PropType<Record<string, string>>, required: true },
    /** 连通测试（App 委托 a2a-host.testConnection），resolve = 成功文案 / reject = 失败文案。 */
    testConnection: {
      type: Function as PropType<(cardUrl: string, token?: string) => Promise<string>>,
      required: true,
    },
  },
  emits: {
    /** 请求编辑指定绑定（宿主进入单条编辑子页面）。 */
    edit: (id: string) => id.length > 0,
    /** 请求删除指定绑定（两步确认后触发，宿主整表替换并持久化）。 */
    remove: (id: string) => id.length > 0,
    /** 空态 CTA：请求进入「新增绑定」子页面。 */
    add: null,
  },
  setup(props, { emit }) {
    /** 每条目的连通测试结果（agentId → 结果含视觉分级）。 */
    const testResults = ref<Record<string, TestResult>>({});
    /** 进行中的连通测试 agentId 集合。 */
    const testing = ref<Set<string>>(new Set());
    /** A3 两步确认：当前处于「待确认删除」状态的条目 id（空串 = 无）。 */
    const confirmRemoveId = ref('');
    /** 两步确认超时定时器（超时自动还原为普通删除钮）。 */
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;

    const disarmConfirm = (): void => {
      confirmRemoveId.value = '';
      if (confirmTimer !== undefined) {
        clearTimeout(confirmTimer);
        confirmTimer = undefined;
      }
    };

    // 组件卸载时清理悬挂定时器（避免跨实例状态泄漏）
    onUnmounted(disarmConfirm);

    /** A3 两步确认删除：首次点击进入待确认态（3s 超时还原），再次点击才真正删除。 */
    const handleRemoveClick = (id: string): void => {
      if (confirmRemoveId.value === id) {
        disarmConfirm();
        emit('remove', id);
        return;
      }
      disarmConfirm();
      confirmRemoveId.value = id;
      confirmTimer = setTimeout(() => {
        confirmRemoveId.value = '';
        confirmTimer = undefined;
      }, CONFIRM_TIMEOUT_MS);
    };

    const handleTest = async (agentId: string, cardUrl: string): Promise<void> => {
      if (testing.value.has(agentId)) return;
      testing.value = new Set([...testing.value, agentId]);
      try {
        const message = await props.testConnection(cardUrl, props.a2aTokens[agentId]);
        testResults.value = { ...testResults.value, [agentId]: { kind: 'ok', text: message } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        testResults.value = {
          ...testResults.value,
          [agentId]: { kind: 'err', text: t('a2a.testFailed', { message }) },
        };
      } finally {
        const next = new Set(testing.value);
        next.delete(agentId);
        testing.value = next;
      }
    };

    /** 元信息行（只读）：标签 + 值（title 可选：长值悬停看全量，A4）。 */
    const metaRow = (label: string, value: VNode | string, title?: string): VNode =>
      h('div', { class: 'a2a-item-meta' }, [
        h('span', { class: 'a2a-item-meta-label' }, label),
        h('span', { class: 'a2a-item-meta-value', title }, value),
      ]);

    /** A4 徽章：未覆盖/Token 状态等非长文本值（muted = 中性灰 / ok = 已配置绿）。 */
    const metaBadge = (text: string, tone: 'ok' | 'muted'): VNode =>
      h('span', { class: `a2a-meta-badge a2a-meta-badge-${tone}` }, text);

    return () => {
      const rows: VNode[] = (props.agent?.a2aAgents ?? []).map((refItem) => {
        const tokenSet = (props.a2aTokens[refItem.id] ?? '').length > 0;
        const armed = confirmRemoveId.value === refItem.id;
        const result = testResults.value[refItem.id];
        return h('div', { class: ['a2a-item', refItem.enabled ? '' : 'a2a-item-off'], key: refItem.id }, [
          // A2 卡片头只留 id + 状态徽章（操作独立成行）
          h('div', { class: 'a2a-item-head' }, [
            h('span', { class: 'a2a-item-id', title: refItem.id }, refItem.id),
            h('span', { class: 'a2a-item-state' }, refItem.enabled ? t('a2a.enabled') : t('a2a.disabled')),
          ]),
          metaRow(t('a2a.cardUrl'), refItem.cardUrl, refItem.cardUrl),
          refItem.endpointOverride !== undefined
            ? metaRow(t('a2a.endpointOverride'), refItem.endpointOverride, refItem.endpointOverride)
            : metaRow(t('a2a.endpointOverride'), metaBadge(t('a2a.noOverride'), 'muted')),
          metaRow(
            'Token',
            metaBadge(tokenSet ? t('a2a.tokenSet') : t('a2a.tokenUnset'), tokenSet ? 'ok' : 'muted')
          ),
          // A2 操作区独立成行：测试连通 / 编辑 / 删除（A3 删除红描边 + 两步确认）
          h('div', { class: 'a2a-item-actions' }, [
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
              class: armed ? 'ghost danger-ghost danger-ghost-armed' : 'ghost danger-ghost',
              type: 'button',
              onClick: () => handleRemoveClick(refItem.id),
            }, armed ? t('a2a.confirmRemove') : t('a2a.remove')),
          ]),
          // A5 测试结果分级：成功绿 / 失败红（左缘状态条）
          result
            ? h('p', { class: `a2a-test-result a2a-test-result-${result.kind}` }, result.text)
            : null,
        ]);
      });

      // A6 空态卡片 + 内嵌「新增绑定」CTA
      if (rows.length === 0) {
        return h('div', { class: 'page-empty' }, [
          h('p', t('a2a.noBindings')),
          h('button', { class: 'ghost', type: 'button', onClick: () => emit('add') }, t('a2a.add.title')),
        ]);
      }
      return h('div', { class: 'a2a-binding-list' }, rows);
    };
  },
});
