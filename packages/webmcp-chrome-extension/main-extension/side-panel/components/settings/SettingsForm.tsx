// 设置页表单编辑组件：LLM 连接配置的「草稿态」编辑。
// 与旧 SettingsPanel（就地直改 App live settings）的关键差异：编辑只落在本地草稿，
// 点「保存」才经 emit('save', draft) 由 App 合并进基线并落盘 —— 未保存不生效。
// dirty（草稿 ≠ 基线）时展示提示 + 提供「取消」还原（未保存离开仅提示，不阻断切页签）。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { defineComponent, computed, ref, watch, type PropType, type VNode } from 'vue';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n/zh-CN';
import type { PanelSettings } from '../../runtime/panel-client';

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
  'sessionRetentionLimit',
  'sessionLoadLimit',
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
    ): VNode => (
      <label>
        <span>{label}</span>
        <input
          type={attrs.type}
          placeholder={attrs.placeholder}
          autocomplete={attrs.autocomplete}
          value={draft.value[key]}
          onInput={(event: Event) => {
            draft.value[key] = (event.target as HTMLInputElement).value;
          }}
        />
        {attrs.hint ? <p class="settings-hint">{attrs.hint}</p> : null}
      </label>
    );

    /** 协议展示文案的 i18n 键。 */
    const PROTOCOL_KEY = {
      'openai-compat': 'settings.summary.protocolOpenai',
      anthropic: 'settings.summary.protocolAnthropic',
    } as const satisfies Record<PanelSettings['apiProtocol'], MessageKey>;

    /** 协议类型下拉（R4 决策：仅 openai-compat / anthropic 两个适配器）。 */
    const protocolSelect = (): VNode => (
      <label class="settings-field">
        <span>{t('settings.form.protocol')}</span>
        <select
          value={draft.value.apiProtocol}
          onChange={(event: Event) => {
            draft.value.apiProtocol = (event.target as HTMLSelectElement).value as PanelSettings['apiProtocol'];
          }}
        >
          <option value="openai-compat">{t(PROTOCOL_KEY['openai-compat'])}</option>
          <option value="anthropic">{t(PROTOCOL_KEY.anthropic)}</option>
        </select>
        <p class="settings-hint">{t('settings.form.protocolHint')}</p>
      </label>
    );

    /** max_tokens 输入（仅 Anthropic 协议消费；协议必填项）。 */
    const maxTokensInput = (): VNode => (
      <label class="settings-field">
        <span>{t('settings.form.maxTokens')}</span>
        <input
          type="number"
          min={1}
          step={1}
          value={draft.value.maxTokens}
          onInput={(event: Event) => {
            const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
            draft.value.maxTokens = Number.isInteger(parsed) && parsed > 0 ? parsed : 4096;
          }}
        />
        <p class="settings-hint">{t('settings.form.maxTokensHint')}</p>
      </label>
    );

    const checkbox = (key: 'consoleOutput', text: string): VNode => (
      <label class="settings-check">
        <input
          type="checkbox"
          checked={draft.value[key]}
          onChange={(event: Event) => {
            draft.value[key] = (event.target as HTMLInputElement).checked;
          }}
        />
        <span>{text}</span>
      </label>
    );

    const textareaInput = (label: string, attrs: { placeholder: string; rows: number }): VNode => (
      <label class="settings-field">
        <span>{label}</span>
        <textarea
          class="settings-textarea"
          rows={attrs.rows}
          placeholder={attrs.placeholder}
          value={draft.value.systemPrompt}
          onInput={(event: Event) => {
            draft.value.systemPrompt = (event.target as HTMLTextAreaElement).value;
          }}
        />
      </label>
    );

    /** 通用数字输入（泛化绑定：历史轮数上限 / 会话保留上限 / 会话加载条数）。 */
    const numberInput = (
      label: string,
      key: 'maxHistoryTurns' | 'sessionRetentionLimit' | 'sessionLoadLimit',
      attrs: { min: number; step: number; hint: string }
    ): VNode => (
      <label class="settings-field">
        <span>{label}</span>
        <input
          type="number"
          min={attrs.min}
          step={attrs.step}
          value={draft.value[key]}
          onInput={(event: Event) => {
            const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
            draft.value[key] = Number.isInteger(parsed) && parsed >= attrs.min ? parsed : attrs.min;
          }}
        />
        <p class="settings-hint">{attrs.hint}</p>
      </label>
    );

    // S6：编辑表单与摘要摘要同构分组（三组标题，API Key 保持首字段）
    const groupTitle = (key: 'settings.summary.group.auth' | 'settings.summary.group.generation' | 'settings.summary.group.behavior'): VNode => (
      <div class="settings-group-title">{t(key)}</div>
    );

    return () => (
      <section class="settings">
        {groupTitle('settings.summary.group.auth')}
        {textInput('API Key', 'apiKey', { type: 'password', placeholder: 'sk-...', autocomplete: 'off' })}
        {protocolSelect()}
        {textInput('Base URL', 'baseUrl', { type: 'text', placeholder: 'https://api.deepseek.com' })}
        {textInput('API Path', 'apiPath', {
          type: 'text',
          placeholder: '/chat/completions',
          hint: t('settings.form.apiPathHint'),
        })}
        {draft.value.apiProtocol === 'anthropic' ? maxTokensInput() : null}
        {groupTitle('settings.summary.group.generation')}
        {textInput(t('settings.form.model'), 'model', { type: 'text', placeholder: 'deepseek-v4-flash' })}
        {textareaInput(t('settings.form.systemPrompt'), {
          placeholder: t('settings.form.systemPromptPlaceholder'),
          rows: 4,
        })}
        {numberInput(t('settings.form.maxHistoryTurns'), 'maxHistoryTurns', {
          min: 0,
          step: 1,
          hint: t('settings.form.maxHistoryTurnsHint'),
        })}
        {groupTitle('settings.summary.group.behavior')}
        {numberInput(t('settings.form.sessionRetentionLimit'), 'sessionRetentionLimit', {
          min: 1,
          step: 1,
          hint: t('settings.form.sessionRetentionLimitHint'),
        })}
        {numberInput(t('settings.form.sessionLoadLimit'), 'sessionLoadLimit', {
          min: 1,
          step: 1,
          hint: t('settings.form.sessionLoadLimitHint'),
        })}
        {checkbox('consoleOutput', t('settings.form.consoleOutput'))}
        <div class="settings-form-actions">
          <button type="button" disabled={props.busy} onClick={() => submit()}>
            {t('common.save')}
          </button>
          <button
            class="ghost"
            type="button"
            disabled={props.busy}
            onClick={() => cancel()}
          >
            {t('common.cancel')}
          </button>
        </div>
        {props.busy ? (
          <p class="settings-hint">{t('settings.form.busyHint')}</p>
        ) : dirty.value ? (
          <p class="settings-hint settings-hint-warn">{t('settings.form.dirtyHint')}</p>
        ) : null}
        <p class="settings-hint">{t('settings.form.keyLocalHint')}</p>
      </section>
    );
  },
});
