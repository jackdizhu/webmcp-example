// A2A 绑定表单组件（components/a2a/，2026-09-13 新增/编辑统一；2026-09-16 协议配置扩展）。
// 新增与编辑共用一套表单，消除 A2aAddForm / A2aItemEditor 两套重复字段与校验。
// - mode='add'：id 可编辑（格式 + 重复校验），enabled 恒 true，提交按钮「添加并启用」。
// - mode='edit'：id 只读（agentKey 创建后不可变），显示启停开关，草稿从 item 拷贝。
// 协议扩展：表单顶部协议单选（jsonrpc / dify），按协议切换字段组——
// - jsonrpc：卡片地址 + 端点覆盖 + Bearer Token（现状）；
// - dify：chat-messages 接口地址 + 显示名/描述 + 响应模式 + inputs 默认值（JSON）+ API Key。
// 草稿态：可选文本字段统一用空串表示「未填写」（exactOptionalPropertyTypes 字段移除语义），
// 协议分支的归一化落库由宿主（A2aAgentsSection.handleFormSubmit）完成。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { defineComponent, ref, watch, type PropType, type VNode } from 'vue';
import { isHttpUrl, validateA2aAgentId, type AgentA2aProtocol, type AgentA2aRef } from 'webmcp-agent-chat-core';
import { t } from '../../i18n';

/** 统一提交载荷：可选文本字段空串 = 未填写；inputsJson 由宿主解析为对象。 */
export interface A2aFormPayload {
  id: string;
  protocol: AgentA2aProtocol;
  enabled: boolean;
  /** jsonrpc：卡片地址。 */
  cardUrl: string;
  /** jsonrpc：端点覆盖。 */
  endpointOverride: string;
  /** dify：chat-messages 完整地址。 */
  endpoint: string;
  /** dify：响应模式。 */
  responseMode: 'streaming' | 'blocking';
  /** dify：工具展示名。 */
  displayName: string;
  /** dify：工具描述。 */
  description: string;
  /** dify：inputs 默认值（JSON 文本，空串 = {}）。 */
  inputsJson: string;
  /** 凭据（jsonrpc bearer token / dify api-key）。 */
  token: string;
}

export const A2aBindingForm = defineComponent({
  name: 'A2aBindingForm',
  props: {
    /** 表单形态：add = 新增绑定；edit = 编辑既有绑定。 */
    mode: { type: String as PropType<'add' | 'edit'>, required: true },
    /** add 模式：现有配置草稿（重复 id 校验用）。 */
    refs: { type: Array as PropType<AgentA2aRef[]>, default: () => [] },
    /** edit 模式：待编辑条目基线（本组件只读不直改；add 模式不传）。 */
    item: { type: Object as PropType<AgentA2aRef>, default: null },
    /** edit 模式：基线凭据（App a2aTokens 快照中该条目的当前值）。 */
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
    const draftProtocol = ref<AgentA2aProtocol>('jsonrpc');
    const cardUrl = ref('');
    const endpointOverride = ref('');
    const endpoint = ref('');
    const responseMode = ref<'streaming' | 'blocking'>('streaming');
    const displayName = ref('');
    const description = ref('');
    const inputsJson = ref('');
    const enabled = ref(true);
    const draftToken = ref('');
    const error = ref('');

    const alignToItem = (): void => {
      const item = props.item;
      draftId.value = item?.id ?? '';
      draftProtocol.value = item?.protocol ?? 'jsonrpc';
      cardUrl.value = item?.cardUrl ?? '';
      endpointOverride.value = item?.endpointOverride ?? '';
      endpoint.value = item?.endpoint ?? '';
      responseMode.value = item?.responseMode ?? 'streaming';
      displayName.value = item?.displayName ?? '';
      description.value = item?.description ?? '';
      inputsJson.value = item?.inputs !== undefined ? JSON.stringify(item.inputs) : '';
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
        const agent = props.refs;
        if (agent.some((ref) => ref.id === id)) {
          error.value = t('a2a.add.idExists', { id });
          return;
        }
      }
      if (draftProtocol.value === 'jsonrpc') {
        const card = cardUrl.value.trim();
        if (card.length === 0 || !isHttpUrl(card)) {
          error.value = isAdd ? t('a2a.add.cardUrlInvalid') : t('a2a.cardUrlError', { id });
          return;
        }
      } else {
        const difyEndpoint = endpoint.value.trim();
        if (difyEndpoint.length === 0 || !isHttpUrl(difyEndpoint)) {
          error.value = t('a2a.endpointDifyError');
          return;
        }
        const raw = inputsJson.value.trim();
        if (raw.length > 0) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              error.value = t('a2a.add.inputsInvalid');
              return;
            }
          } catch {
            error.value = t('a2a.add.inputsInvalid');
            return;
          }
        }
      }
      emit('submit', {
        id,
        protocol: draftProtocol.value,
        enabled: isAdd ? true : enabled.value,
        cardUrl: cardUrl.value.trim(),
        endpointOverride: endpointOverride.value.trim(),
        endpoint: endpoint.value.trim(),
        responseMode: responseMode.value,
        displayName: displayName.value.trim(),
        description: description.value.trim(),
        inputsJson: inputsJson.value.trim(),
        token: draftToken.value.trim(),
      });
      if (isAdd) {
        // 乐观清空草稿（宿主落库失败经 App 级 notice 提示）
        draftId.value = '';
        draftProtocol.value = 'jsonrpc';
        cardUrl.value = '';
        endpointOverride.value = '';
        endpoint.value = '';
        responseMode.value = 'streaming';
        displayName.value = '';
        description.value = '';
        inputsJson.value = '';
        draftToken.value = '';
      }
    };

    return () => {
      const isAdd = props.mode === 'add';
      const isDify = draftProtocol.value === 'dify';
      // A7：字段补 label（输入后 placeholder 消失仍可辨认字段语义；可选字段在标签中标注）
      const field = (label: string, control: VNode | VNode[]): VNode => (
        <label class="a2a-form-field">
          <span>{label}</span>
          {control}
        </label>
      );
      const textInput = (
        value: string,
        placeholder: string,
        onInput: (value: string) => void,
        type: 'text' | 'url' | 'password' = 'text'
      ): VNode => (
        <input
          type={type}
          placeholder={placeholder}
          autocomplete={type === 'password' ? 'off' : undefined}
          value={value}
          onInput={(event: Event) => {
            onInput((event.target as HTMLInputElement).value);
          }}
        />
      );
      // 协议单选（两选项共享 name 分组）
      const protocolRadio = (value: AgentA2aProtocol, label: string): VNode => (
        <label class="a2a-form-radio">
          <input
            type="radio"
            name="a2a-form-protocol"
            checked={draftProtocol.value === value}
            onChange={() => {
              draftProtocol.value = value;
              error.value = '';
            }}
          />
          <span>{label}</span>
        </label>
      );

      return (
        <div class="a2a-add-form">
          {/* id：add = 可编辑输入（格式/重复校验）；edit = 只读标签 + 启停开关（创建后不可修改） */}
          {isAdd ? (
            field(
              t('a2a.form.id'),
              textInput(draftId.value, t('a2a.add.idPlaceholder'), (value) => {
                draftId.value = value;
              })
            )
          ) : (
            <div class="a2a-item-head">
              <input
                type="checkbox"
                id="a2a-item-enabled"
                checked={enabled.value}
                title={t('a2a.enableTitle')}
                onChange={(event: Event) => {
                  enabled.value = (event.target as HTMLInputElement).checked;
                }}
              />
              <label class="a2a-item-id" for="a2a-item-enabled" title={t('a2a.form.id')}>
                {props.item?.id ?? ''}
              </label>
              <span class="a2a-item-state">{enabled.value ? t('a2a.enabled') : t('a2a.disabled')}</span>
            </div>
          )}
          {/* 协议单选（2026-09-16 协议配置扩展） */}
          {field(t('a2a.form.protocol'), [
            protocolRadio('jsonrpc', t('a2a.protocol.jsonrpc')),
            protocolRadio('dify', t('a2a.protocol.dify')),
          ])}
          {isDify
            ? [
                field(
                  t('a2a.form.endpoint'),
                  textInput(endpoint.value, t('a2a.add.endpointDifyPlaceholder'), (value) => {
                    endpoint.value = value;
                  }, 'url')
                ),
                field(
                  t('a2a.form.displayNameOptional'),
                  textInput(displayName.value, t('a2a.add.displayNamePlaceholder'), (value) => {
                    displayName.value = value;
                  })
                ),
                field(
                  t('a2a.form.descriptionOptional'),
                  textInput(description.value, t('a2a.add.descriptionPlaceholder'), (value) => {
                    description.value = value;
                  })
                ),
                field(
                  t('a2a.form.responseMode'),
                  <select
                    value={responseMode.value}
                    onChange={(event: Event) => {
                      responseMode.value = (event.target as HTMLSelectElement).value as 'streaming' | 'blocking';
                    }}
                  >
                    <option value="streaming">{t('a2a.responseMode.streaming')}</option>
                    <option value="blocking">{t('a2a.responseMode.blocking')}</option>
                  </select>
                ),
                field(
                  t('a2a.form.inputsOptional'),
                  textInput(inputsJson.value, t('a2a.add.inputsPlaceholder'), (value) => {
                    inputsJson.value = value;
                  })
                ),
                field(
                  t('a2a.form.tokenDifyOptional'),
                  textInput(draftToken.value, isAdd ? t('a2a.add.tokenDifyPlaceholder') : t('a2a.tokenPlaceholder', { id: props.item?.id ?? '' }), (value) => {
                    draftToken.value = value;
                  }, 'password')
                ),
              ]
            : [
                field(
                  t('a2a.cardUrl'),
                  textInput(cardUrl.value, isAdd ? t('a2a.add.cardUrlPlaceholder') : 'https://example.com/.well-known/agent-card.json', (value) => {
                    cardUrl.value = value;
                  }, 'url')
                ),
                field(
                  t('a2a.form.endpointOptional'),
                  textInput(endpointOverride.value, t('a2a.endpointPlaceholder'), (value) => {
                    endpointOverride.value = value;
                  }, 'url')
                ),
                field(
                  t('a2a.form.tokenOptional'),
                  textInput(draftToken.value, isAdd ? t('a2a.add.tokenPlaceholder') : t('a2a.tokenPlaceholder', { id: props.item?.id ?? '' }), (value) => {
                    draftToken.value = value;
                  }, 'password')
                ),
              ]}
          {error.value ? <p class="settings-hint settings-hint-error">{error.value}</p> : null}
          {isAdd ? (
            <button type="button" disabled={props.busy} onClick={() => handleSubmit()}>
              {t('a2a.add.submit')}
            </button>
          ) : (
            <div class="a2a-edit-actions">
              <button type="button" disabled={props.busy} onClick={() => handleSubmit()}>
                {t('common.save')}
              </button>
              <button
                class="ghost"
                type="button"
                disabled={props.busy}
                onClick={() => emit('cancel')}
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>
      );
    };
  },
});
