// A2A 绑定表单组件（components/a2a/，2026-09-13 新增/编辑统一）：新增与编辑共用一套表单，
// 消除 A2aAddForm / A2aItemEditor 两套重复字段与校验（编辑页复用新增组件）。
// - mode='add'：id 可编辑（格式 + 重复校验），enabled 恒 true，提交按钮「添加并启用」。
// - mode='edit'：id 只读（agentKey 创建后不可变），显示启停开关，草稿从 item 拷贝，
//   校验仅卡片地址 HTTP(S)；按钮「保存/取消」，取消经 emit('cancel') 回列表。
// 草稿态：端点覆盖统一用空串表示「未覆盖」（exactOptionalPropertyTypes 字段移除语义），
// 保存时由宿主（A2aAgentsSection）归一化落库。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, watch, type PropType, type VNode } from 'vue';
import { isHttpUrl, validateA2aAgentId, type AgentA2aRef } from 'webmcp-agent-chat-core';
import { t } from '../../i18n';
import type { A2aBindingTargetAgent } from './A2aBindingList';

/** 统一提交载荷：endpointOverride 空串 = 未覆盖（回落卡片接口地址）。 */
export interface A2aFormPayload {
  id: string;
  cardUrl: string;
  endpointOverride: string;
  enabled: boolean;
  token: string;
}

export const A2aBindingForm = defineComponent({
  name: 'A2aBindingForm',
  props: {
    /** 表单形态：add = 新增绑定；edit = 编辑既有绑定。 */
    mode: { type: String as PropType<'add' | 'edit'>, required: true },
    /** add 模式：编辑目标智能体（重复 id 校验用；null = 无目标，提交时报错）。 */
    targetAgent: { type: Object as PropType<A2aBindingTargetAgent | null>, default: null },
    /** edit 模式：待编辑条目基线（本组件只读不直改；add 模式不传）。 */
    item: { type: Object as PropType<AgentA2aRef>, default: null },
    /** edit 模式：基线 token（App a2aTokens 快照中该条目的当前值）。 */
    token: { type: String, default: '' },
    /** 执行锁（对话/relay 调用进行中）：提交按钮禁用。 */
    busy: { type: Boolean, required: true },
  },
  emits: {
    submit: (payload: A2aFormPayload) => payload.id.length > 0,
    /** 仅 edit 模式：放弃草稿回列表。 */
    cancel: null,
  },
  setup(props, { emit }) {
    // ---- 本地草稿态（唯一可写副本；add 空草稿起步，edit 对齐 item 基线）----
    const draftId = ref('');
    const cardUrl = ref('');
    const endpointOverride = ref('');
    const enabled = ref(true);
    const draftToken = ref('');
    const error = ref('');

    const alignToItem = (): void => {
      const item = props.item;
      draftId.value = item?.id ?? '';
      cardUrl.value = item?.cardUrl ?? '';
      endpointOverride.value = item?.endpointOverride ?? '';
      enabled.value = item?.enabled ?? true;
      draftToken.value = props.token;
      error.value = '';
    };

    if (props.mode === 'edit') {
      alignToItem();
      // 条目切换（组件复用场景）时对齐基线
      watch(() => props.item?.id, alignToItem);
    }

    const handleSubmit = (): void => {
      error.value = '';
      const isAdd = props.mode === 'add';
      const id = isAdd ? draftId.value.trim() : (props.item?.id ?? '');
      if (isAdd) {
        try {
          validateA2aAgentId(id);
        } catch {
          error.value = t('a2a.add.idInvalid');
          return;
        }
        const agent = props.targetAgent;
        if (agent === null) {
          error.value = t('a2a.add.noAgent');
          return;
        }
        if (agent.a2aAgents.some((ref) => ref.id === id)) {
          error.value = t('a2a.add.idExists', { id });
          return;
        }
      }
      const card = cardUrl.value.trim();
      if (card.length === 0 || !isHttpUrl(card)) {
        error.value = isAdd ? t('a2a.add.cardUrlInvalid') : t('a2a.cardUrlError', { id });
        return;
      }
      emit('submit', {
        id,
        cardUrl: card,
        endpointOverride: endpointOverride.value.trim(),
        enabled: isAdd ? true : enabled.value,
        token: draftToken.value.trim(),
      });
      if (isAdd) {
        // 乐观清空草稿（宿主落库失败经 App 级 notice 提示）
        draftId.value = '';
        cardUrl.value = '';
        endpointOverride.value = '';
        draftToken.value = '';
      }
    };

    return () => {
      const isAdd = props.mode === 'add';
      // A7：字段补 label（输入后 placeholder 消失仍可辨认字段语义；可选字段在标签中标注）
      const field = (label: string, control: VNode): VNode =>
        h('label', { class: 'a2a-form-field' }, [h('span', label), control]);
      return h('div', { class: 'a2a-add-form' }, [
        // id：add = 可编辑输入（格式/重复校验）；edit = 只读标签 + 启停开关（创建后不可修改）
        isAdd
          ? field(
              t('a2a.form.id'),
              h('input', {
                type: 'text',
                placeholder: t('a2a.add.idPlaceholder'),
                value: draftId.value,
                onInput: (event: Event) => {
                  draftId.value = (event.target as HTMLInputElement).value;
                },
              })
            )
          : h('div', { class: 'a2a-item-head' }, [
              h('input', {
                type: 'checkbox',
                id: 'a2a-item-enabled',
                checked: enabled.value,
                title: t('a2a.enableTitle'),
                onChange: (event: Event) => {
                  enabled.value = (event.target as HTMLInputElement).checked;
                },
              }),
              h('label', { class: 'a2a-item-id', for: 'a2a-item-enabled', title: t('a2a.form.id') }, props.item?.id ?? ''),
              h('span', { class: 'a2a-item-state' }, enabled.value ? t('a2a.enabled') : t('a2a.disabled')),
            ]),
        field(
          t('a2a.cardUrl'),
          h('input', {
            type: 'url',
            placeholder: isAdd
              ? t('a2a.add.cardUrlPlaceholder')
              : 'https://example.com/.well-known/agent-card.json',
            value: cardUrl.value,
            onInput: (event: Event) => {
              cardUrl.value = (event.target as HTMLInputElement).value;
            },
          })
        ),
        field(
          t('a2a.form.endpointOptional'),
          h('input', {
            type: 'url',
            placeholder: t('a2a.endpointPlaceholder'),
            value: endpointOverride.value,
            onInput: (event: Event) => {
              endpointOverride.value = (event.target as HTMLInputElement).value;
            },
          })
        ),
        field(
          t('a2a.form.tokenOptional'),
          h('input', {
            type: 'password',
            placeholder: isAdd ? t('a2a.add.tokenPlaceholder') : t('a2a.tokenPlaceholder', { id: props.item?.id ?? '' }),
            autocomplete: 'off',
            value: draftToken.value,
            onInput: (event: Event) => {
              draftToken.value = (event.target as HTMLInputElement).value;
            },
          })
        ),
        error.value ? h('p', { class: 'settings-hint settings-hint-error' }, error.value) : null,
        isAdd
          ? h('button', { type: 'button', disabled: props.busy, onClick: () => handleSubmit() }, t('a2a.add.submit'))
          : h('div', { class: 'a2a-edit-actions' }, [
              h('button', { type: 'button', disabled: props.busy, onClick: () => handleSubmit() }, t('common.save')),
              h('button', {
                class: 'ghost',
                type: 'button',
                disabled: props.busy,
                onClick: () => emit('cancel'),
              }, t('common.cancel')),
            ]),
      ]);
    };
  },
});
