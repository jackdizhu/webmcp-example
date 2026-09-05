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
  },
  setup(props, { emit }) {
    const textInput = (
      label: string,
      key: 'apiKey' | 'baseUrl' | 'model',
      attrs: { type: string; placeholder: string; autocomplete?: string }
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

    return () =>
      h('section', { class: 'settings' }, [
        textInput('API Key', 'apiKey', { type: 'password', placeholder: 'sk-...', autocomplete: 'off' }),
        textInput('Base URL', 'baseUrl', { type: 'text', placeholder: 'https://api.deepseek.com/v1' }),
        textInput('模型', 'model', { type: 'text', placeholder: 'deepseek-chat' }),
        checkbox('debugMode', '调试模式（开启「调试」Tab，可不经 LLM 手动执行工具）'),
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
