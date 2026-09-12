// 设置面板：LLM 连接配置、调试模式 / 控制台输出开关、本地日志管理区块。
// 状态归属 App（settings reactive 对象直接传入，字段变更就地生效），保存/导出/清空动作回抛给 App。
import { defineComponent, h, type PropType, type VNode } from 'vue';
import type { PanelSettings } from '../panel-client';

export const SettingsPanel = defineComponent({
  name: 'SettingsPanel',
  props: {
    settings: { type: Object as PropType<PanelSettings>, required: true },
    busy: { type: Boolean, required: true },
    /** 本地日志条数文案（App 异步刷新后传入）。 */
    logCountText: { type: String, required: true },
    /** 日志操作反馈文案（导出/清空结果）。 */
    logHint: { type: String, required: true },
  },
  emits: {
    save: null,
    'export-logs': null,
    'clear-logs': null,
    /** 快速切换调试模式（立即持久化并生效，不等「保存」）。 */
    'toggle-debug': null,
  },
  setup(props, { emit }) {
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
          value: props.settings[key],
          onInput: (event: Event) => {
            props.settings[key] = (event.target as HTMLInputElement).value;
          },
        }),
        attrs.hint ? h('p', { class: 'settings-hint' }, attrs.hint) : null,
      ]);

    /** 协议类型下拉（R4 决策：仅 openai-compat / anthropic 两个适配器）。 */
    const protocolSelect = (): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', 'API 协议'),
        h(
          'select',
          {
            value: props.settings.apiProtocol,
            onChange: (event: Event) => {
              props.settings.apiProtocol = (event.target as HTMLSelectElement).value as PanelSettings['apiProtocol'];
            },
          },
          [
            h('option', { value: 'openai-compat' }, 'OpenAI 兼容（chat completions）'),
            h('option', { value: 'anthropic' }, 'Anthropic（Messages API）'),
          ]
        ),
        h('p', { class: 'settings-hint' }, 'Anthropic 协议走 /v1/messages（x-api-key 鉴权，max_tokens 必填）。'),
      ]);

    /** max_tokens 输入（仅 Anthropic 协议消费；协议必填项）。 */
    const maxTokensInput = (): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', 'Max Tokens'),
        h('input', {
          type: 'number',
          min: 1,
          step: 1,
          value: props.settings.maxTokens,
          onInput: (event: Event) => {
            const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
            props.settings.maxTokens = Number.isInteger(parsed) && parsed > 0 ? parsed : 4096;
          },
        }),
        h('p', { class: 'settings-hint' }, '单次回复的最大 token 数（默认 4096；仅 Anthropic 协议使用）。'),
      ]);

    const checkbox = (key: 'debugMode' | 'consoleOutput', text: string): VNode =>
      h('label', { class: 'settings-check' }, [
        h('input', {
          type: 'checkbox',
          checked: props.settings[key],
          onChange: (event: Event) => {
            props.settings[key] = (event.target as HTMLInputElement).checked;
          },
        }),
        h('span', text),
      ]);

    const textareaInput = (
      label: string,
      key: 'systemPrompt',
      attrs: { placeholder: string; rows: number }
    ): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', label),
        h('textarea', {
          class: 'settings-textarea',
          rows: attrs.rows,
          placeholder: attrs.placeholder,
          value: props.settings[key],
          onInput: (event: Event) => {
            props.settings[key] = (event.target as HTMLTextAreaElement).value;
          },
        }),
      ]);

    const numberInput = (
      label: string,
      key: 'maxHistoryTurns',
      attrs: { min: number; step: number; hint: string }
    ): VNode =>
      h('label', { class: 'settings-field' }, [
        h('span', label),
        h('input', {
          type: 'number',
          min: attrs.min,
          step: attrs.step,
          value: props.settings[key],
          onInput: (event: Event) => {
            const raw = (event.target as HTMLInputElement).value;
            const parsed = Number.parseInt(raw, 10);
            props.settings[key] = Number.isInteger(parsed) && parsed >= attrs.min ? parsed : attrs.min;
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
        hint: '请求路径，拼接在 Base URL 之后；清空后不回退默认路径，发起对话会提示：请配置apiPath。Anthropic 默认 /v1/messages，OpenAI 兼容默认 /chat/completions。',
      }),
      props.settings.apiProtocol === 'anthropic' ? maxTokensInput() : null,
      textInput('模型', 'model', { type: 'text', placeholder: 'deepseek-v4-flash' }),
        textareaInput('系统提示词', 'systemPrompt', {
          placeholder: '留空则使用内置的页面工具验证助手提示词',
          rows: 4,
        }),
        numberInput('历史对话轮数上限', 'maxHistoryTurns', {
          min: 0,
          step: 1,
          hint: '每轮发送给 LLM 的历史对话轮数上限（默认 5，0 = 不裁剪）。裁剪以轮为单位，工具执行结果随所属轮一并裁剪，可显著降低 token 消耗。',
        }),
        checkbox('debugMode', '调试模式（侧栏打开时默认进入「tools 调试」页）'),
        // 快速切换：无 Key 用户的一键直达入口（立即生效，不依赖「保存」按钮）
        h(
          'button',
          { class: 'ghost', type: 'button', onClick: () => emit('toggle-debug') },
          props.settings.debugMode ? '⚡ 快速关闭调试模式' : '⚡ 快速开启调试模式（无需 API Key，手动执行工具）'
        ),
        checkbox(
          'consoleOutput',
          '控制台输出（开启后日志同步打印到控制台，带 [traceId] 前缀；默认仅写本地日志）'
        ),
        h('button', { type: 'button', disabled: props.busy, onClick: () => emit('save') }, '保存'),
        h('p', { class: 'settings-hint' }, 'Key 仅保存在本机 chrome.storage.local，不会进入代码仓库。'),
        h('div', { class: 'settings-logs' }, [
          h('span', { class: 'settings-log-count' }, `本地日志：${props.logCountText}`),
          h('button', { class: 'ghost', type: 'button', onClick: () => emit('export-logs') }, '导出日志'),
          h('button', { class: 'ghost', type: 'button', onClick: () => emit('clear-logs') }, '清空日志'),
        ]),
        props.logHint ? h('p', { class: 'settings-hint' }, props.logHint) : null,
      ]);
  },
});
