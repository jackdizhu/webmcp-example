// 设置页表单编辑组件：LLM 连接配置的「草稿态」编辑。
// 与旧 SettingsPanel（就地直改 App live settings）的关键差异：编辑只落在本地草稿，
// 点「保存」才经 emit('save', draft) 由 App 合并进基线并落盘 —— 未保存不生效。
// dirty（草稿 ≠ 基线）时展示提示 + 提供「取消」还原（未保存离开仅提示，不阻断切页签）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, computed, h, ref, watch, type PropType, type VNode } from 'vue';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n/zh-CN';
import type { PanelSettings } from '../../panel-client';

/** 参与编辑与 dirty 比较的字段（debugMode 不在本页 UI 编辑，维持存储兼容原样透传）。 */
const EDITABLE_FIELDS = [
  'apiKey',
  'baseUrl',
  'apiPath',
  'model',
  'apiProtocol',
  'maxTokens',
  'consoleOutput',
  'systemPrompt',
  'maxHistoryTurns',
] as const;

/** 基线快照（plain copy，供草稿初始化/还原与保存提交）。 */
const snapshot = (source: PanelSettings): PanelSettings => ({ ...source });

export const SettingsForm = defineComponent({
  name: 'SettingsForm',
  props: {
    /** 已保存生效的基线配置（App live reactive 对象，本组件只读不直改）。 */
    settings: { type: Object as PropType<PanelSettings>, required: true },
    /** 是否处于编辑模式（进入编辑时草稿重新对齐基线）。 */
    editing: { type: Boolean, required: true },
    /** 执行锁（对话/relay 调用进行中）：保存按钮禁用。 */
    busy: { type: Boolean, required: true },
  },
  emits: {
    /** 保存：携带草稿快照（plain object），由宿主合并进基线并持久化。 */
    save: (draft: PanelSettings) => Boolean(draft),
    /** dirty 状态上抛（宿主转传只读摘要组件做「未保存」提示）。 */
    'update:dirty': (value: boolean) => typeof value === 'boolean',
    /** 取消编辑：宿主退出编辑态回查看页（草稿丢弃由本组件完成）。 */
    cancel: null,
  },
  setup(props, { emit }) {
    // ---- 草稿态（本地，唯一可写副本）----
    const draft = ref<PanelSettings>(snapshot(props.settings));

    /** 草稿是否偏离基线（浅比较可编辑字段；协议切换联动 maxTokens 显隐，一并纳入比较）。 */
    const dirty = computed<boolean>(() =>
      EDITABLE_FIELDS.some((key) => draft.value[key] !== props.settings[key])
    );

    watch(dirty, (value) => emit('update:dirty', value), { immediate: true });

    // 进入编辑模式时草稿对齐基线（取消编辑 = 丢弃草稿回查看态；基线仅在保存/load 时变化）
    watch(
      () => props.editing,
      (isEditing) => {
        if (isEditing) draft.value = snapshot(props.settings);
      },
      { immediate: true }
    );

    const cancel = (): void => {
      // 取消编辑 = 丢弃草稿对齐基线，并外抛 cancel 由宿主退出编辑态回查看页
      draft.value = snapshot(props.settings);
      emit('cancel');
    };

    const submit = (): void => {
      if (props.busy) return;
      emit('save', snapshot(draft.value));
    };

    // ---- 字段控件（绑定草稿，不再直改 props.settings）----
    const textInput = (
      label: string,
      key: 'apiKey' | 'baseUrl' | 'apiPath' | 'model',
      attrs: { type: string; placeholder: string; autocomplete?: string; hint?: string }
    ): VNode =>
      h('label', [
        h('span', label),
        h('input', {
          type: attrs.type,
          placeholder: attrs.placeholder,
          autocomplete: attrs.autocomplete,
          value: draft.value[key],
          onInput: (event: Event) => {
            draft.value[key] = (event.target as HTMLInputElement).value;
          },
        }),
        attrs.hint ? h('p', { class: 'settings-hint' }, attrs.hint) : null,
      ]);

    /** 协议展示文案的 i18n 键。 */
    const PROTOCOL_KEY = {
      'openai-compat': 'settings.summary.protocolOpenai',
      anthropic: 'settings.summary.protocolAnthropic',
    } as const satisfies Record<PanelSettings['apiProtocol'], MessageKey>;

    /** 协议类型下拉（R4 决策：仅 openai-compat / anthropic 两个适配器）。 */
    const protocolSelect = (): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', t('settings.form.protocol')),
        h(
          'select',
          {
            value: draft.value.apiProtocol,
            onChange: (event: Event) => {
              draft.value.apiProtocol = (event.target as HTMLSelectElement).value as PanelSettings['apiProtocol'];
            },
          },
          [
            h('option', { value: 'openai-compat' }, t(PROTOCOL_KEY['openai-compat'])),
            h('option', { value: 'anthropic' }, t(PROTOCOL_KEY.anthropic)),
          ]
        ),
        h('p', { class: 'settings-hint' }, t('settings.form.protocolHint')),
      ]);

    /** max_tokens 输入（仅 Anthropic 协议消费；协议必填项）。 */
    const maxTokensInput = (): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', t('settings.form.maxTokens')),
        h('input', {
          type: 'number',
          min: 1,
          step: 1,
          value: draft.value.maxTokens,
          onInput: (event: Event) => {
            const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
            draft.value.maxTokens = Number.isInteger(parsed) && parsed > 0 ? parsed : 4096;
          },
        }),
        h('p', { class: 'settings-hint' }, t('settings.form.maxTokensHint')),
      ]);

    const checkbox = (key: 'consoleOutput', text: string): VNode =>
      h('label', { class: 'settings-check' }, [
        h('input', {
          type: 'checkbox',
          checked: draft.value[key],
          onChange: (event: Event) => {
            draft.value[key] = (event.target as HTMLInputElement).checked;
          },
        }),
        h('span', text),
      ]);

    const textareaInput = (label: string, attrs: { placeholder: string; rows: number }): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', label),
        h('textarea', {
          class: 'settings-textarea',
          rows: attrs.rows,
          placeholder: attrs.placeholder,
          value: draft.value.systemPrompt,
          onInput: (event: Event) => {
            draft.value.systemPrompt = (event.target as HTMLTextAreaElement).value;
          },
        }),
      ]);

    const numberInput = (label: string, attrs: { min: number; step: number; hint: string }): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', label),
        h('input', {
          type: 'number',
          min: attrs.min,
          step: attrs.step,
          value: draft.value.maxHistoryTurns,
          onInput: (event: Event) => {
            const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
            draft.value.maxHistoryTurns = Number.isInteger(parsed) && parsed >= attrs.min ? parsed : attrs.min;
          },
        }),
        h('p', { class: 'settings-hint' }, attrs.hint),
      ]);

    return () =>
      h('section', { class: 'settings' }, [
        textInput('API Key', 'apiKey', { type: 'password', placeholder: 'sk-...', autocomplete: 'off' }),
        protocolSelect(),
        textInput('Base URL', 'baseUrl', { type: 'text', placeholder: 'https://api.deepseek.com' }),
        textInput('API Path', 'apiPath', {
          type: 'text',
          placeholder: '/chat/completions',
          hint: t('settings.form.apiPathHint'),
        }),
        draft.value.apiProtocol === 'anthropic' ? maxTokensInput() : null,
        textInput(t('settings.form.model'), 'model', { type: 'text', placeholder: 'deepseek-v4-flash' }),
        textareaInput(t('settings.form.systemPrompt'), {
          placeholder: t('settings.form.systemPromptPlaceholder'),
          rows: 4,
        }),
        numberInput(t('settings.form.maxHistoryTurns'), {
          min: 0,
          step: 1,
          hint: t('settings.form.maxHistoryTurnsHint'),
        }),
        checkbox(
          'consoleOutput',
          t('settings.form.consoleOutput')
        ),
        h('div', { class: 'settings-form-actions' }, [
          h('button', { type: 'button', disabled: props.busy, onClick: () => submit() }, t('common.save')),
          h('button', {
            class: 'ghost',
            type: 'button',
            disabled: props.busy,
            onClick: () => cancel(),
          }, t('common.cancel')),
        ]),
        props.busy
          ? h('p', { class: 'settings-hint' }, t('settings.form.busyHint'))
          : dirty.value
            ? h('p', { class: 'settings-hint settings-hint-warn' }, t('settings.form.dirtyHint'))
            : null,
        h('p', { class: 'settings-hint' }, t('settings.form.keyLocalHint')),
      ]);
  },
});
