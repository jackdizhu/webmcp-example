// 设置页只读展示组件：当前「已保存生效」的 LLM 连接配置摘要。
// 与 SettingsForm（草稿编辑态）分离：本组件零输入控件，仅展示 props.settings
// （App 基线快照，仅保存动作会更新）。apiKey 脱敏掩码展示（全掩码，不泄露长度）。
// 页内 UI 优化（2026-09-13 方案二 S1/S4/S5/S7）：
// - S7 卡片壳 .settings-card（左缘 accent 状态条），标题行右侧 slot 承载「编辑配置」按钮
// - S1 摘要分三组 .settings-summary-group（连接与鉴权 / 生成参数 / 行为），英文标签纳入 i18n
// - S4 dirty 提示上移到卡片头下方（第一眼可见）
// - S5 长值（Base URL / API Path / Model）单行省略（CSS）+ title 悬停看全量
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, type PropType, type VNode } from 'vue';
import { t } from '../../i18n';
import type { PanelSettings } from '../../panel-client';

/** 固定长度全掩码：不保留任何明文片段，也不泄露真实长度（2026-09-13 由「首尾保留」改为全脱敏）。 */
const API_KEY_MASK = '••••••••••';

/** apiKey 脱敏：空 = 未配置；非空一律全掩码展示（不保留首尾字符）。 */
export const maskApiKey = (key: string): string => {
  if (key.length === 0) return t('settings.summary.notSet');
  return API_KEY_MASK;
};

/** 协议展示文案的 i18n 键。 */
const PROTOCOL_KEY: Record<PanelSettings['apiProtocol'], import('../../i18n/zh-CN').MessageKey> = {
  'openai-compat': 'settings.summary.protocolOpenai',
  anthropic: 'settings.summary.protocolAnthropic',
};

export const SettingsSummary = defineComponent({
  name: 'SettingsSummary',
  props: {
    /** 当前已保存生效的配置（App 基线，仅保存动作更新）。 */
    settings: { type: Object as PropType<PanelSettings>, required: true },
    /** 表单存在未保存修改时提示（只读视图与草稿可能不一致）。 */
    dirty: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    /** 摘要行：标签 + 值（title 可选：长值悬停看全量，S5；单行省略由 CSS 承担）。 */
    const row = (label: string, value: VNode | string, title?: string): VNode =>
      h('div', { class: 'settings-summary-row' }, [
        h('span', { class: 'settings-summary-label' }, label),
        h('span', { class: 'settings-summary-value', title }, value),
      ]);

    /** S1 分组容器：mono 组标题 + 发丝分隔线（条件行允许 null，渲染前过滤）。 */
    const group = (title: string, rows: (VNode | null)[]): VNode =>
      h(
        'div',
        { class: 'settings-summary-group' },
        [h('h5', title), ...rows.filter((entry): entry is VNode => entry !== null)]
      );

    return () =>
      h('section', { class: 'settings-card' }, [
        // S7 卡片头：标题 + 右侧 slot（宿主放「编辑配置」按钮，省一行孤悬按钮）
        h('div', { class: 'settings-card-head' }, [h('h4', t('settings.summary.title')), slots.actions?.()]),
        // S4 dirty 提示上移到卡片头下方（第一眼可见）
        props.dirty
          ? h('p', { class: 'settings-hint settings-hint-warn' }, t('settings.summary.dirtyHint'))
          : null,
        group(t('settings.summary.group.auth'), [
          row(t('settings.summary.apiKey'), maskApiKey(props.settings.apiKey)),
          row(t('settings.summary.protocol'), t(PROTOCOL_KEY[props.settings.apiProtocol])),
          row(
            t('settings.summary.baseUrl'),
            props.settings.baseUrl.length > 0 ? props.settings.baseUrl : t('settings.summary.empty'),
            props.settings.baseUrl.length > 0 ? props.settings.baseUrl : undefined
          ),
          row(
            t('settings.summary.apiPath'),
            props.settings.apiPath.length > 0 ? props.settings.apiPath : t('settings.summary.apiPathEmpty'),
            props.settings.apiPath.length > 0 ? props.settings.apiPath : undefined
          ),
          props.settings.apiProtocol === 'anthropic'
            ? row('Max Tokens', String(props.settings.maxTokens))
            : null,
        ]),
        group(t('settings.summary.group.generation'), [
          row(
            t('settings.summary.model'),
            props.settings.model.length > 0 ? props.settings.model : t('settings.summary.empty'),
            props.settings.model.length > 0 ? props.settings.model : undefined
          ),
          row(t('settings.summary.maxHistoryTurns'), String(props.settings.maxHistoryTurns)),
        ]),
        group(t('settings.summary.group.behavior'), [
          row(
            t('settings.summary.consoleOutput'),
            props.settings.consoleOutput ? t('settings.summary.on') : t('settings.summary.off')
          ),
        ]),
      ]);
  },
});
