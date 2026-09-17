// 数据源页只读展示组件：全局标签页连接状态摘要 + 各页签状态表（含状态徽章）。
// 与 DataSourcePicker（编辑：勾选/重置）分离（2026-09-13 编辑态/只读态拆分）：
// 本组件零输入控件，纯快照展示（数据源 = SW 推送的 statuses 只读镜像）。
// 页内 UI 优化（2026-09-13 方案二）：
// - D1 选中标识：选中项 accent 状态槽 +「已选中」徽章（connected ≠ selected，必须分别呈现）
// - D2 排序与 Picker 统一（选中在前，其余按 tabId），view/edit 两态切换不再跳变
// - D7 同名页签区分：title 下补 URL 次行（mono 单行省略 + title 悬停看全量）
// - D6 空态统一为 .page-empty 卡片规格；统计行并入小节标题行（.section-head）
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { defineComponent, type PropType } from 'vue';
import type { RelayTabStatus } from '../../../../core/relay-status-protocol';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n/zh-CN';

/** 各连接状态的 i18n 键（与 RelayStatusBar 共用同一套键）。 */
const STATE_KEY: Record<string, MessageKey> = {
  connected: 'relayBar.state.connected',
  connecting: 'relayBar.state.connecting',
  reconnecting: 'relayBar.state.reconnecting',
  dormant: 'relayBar.state.dormant',
  stopped: 'relayBar.state.stopped',
};

export const DataSourceSummary = defineComponent({
  name: 'DataSourceSummary',
  props: {
    /** 全部 http(s) 标签页状态（SW 推送快照，只读展示）。 */
    statuses: { type: Array as PropType<RelayTabStatus[]>, required: true },
  },
  setup(props) {
    return () => {
      if (props.statuses.length === 0) {
        return (
          <section class="datasource-summary">
            <h4>{t('ds.summary.title')}</h4>
            <div class="page-empty">{t('ds.summary.empty')}</div>
          </section>
        );
      }
      const connected = props.statuses.filter((status) => status.state === 'connected').length;
      const selectedCount = props.statuses.filter((status) => status.selected === true).length;
      // D2：排序与 DataSourcePicker 统一 —— 选中项在前，其余按 tabId 升序，两态切换不跳变
      const sorted = [...props.statuses].sort((a, b) => {
        const aSelected = a.selected === true ? 0 : 1;
        const bSelected = b.selected === true ? 0 : 1;
        if (aSelected !== bSelected) return aSelected - bSelected;
        return a.tabId - b.tabId;
      });
      return (
        <section class="datasource-summary">
          <div class="section-head">
            <h4>{t('ds.summary.title')}</h4>
            <span class="relay-page-status">
              {t('ds.summary.stats', {
                connected,
                selected: selectedCount,
                total: props.statuses.length,
              })}
            </span>
          </div>
          <ul class="datasource-summary-list">
            {sorted.map((status) => {
              const isSelected = status.selected === true;
              const stateKey = STATE_KEY[status.state];
              return (
                <li
                  class={['relay-source-item', isSelected ? 'relay-source-item-selected' : '']}
                  key={String(status.tabId)}
                >
                  <div class="relay-source-info">
                    <span class="relay-source-title">
                      {status.title || status.url || t('common.tabLabel', { id: status.tabId })}
                    </span>
                    {/* D7：URL 次行 —— 同名页签靠地址区分；无 url（异常态）则不渲染 */}
                    {status.url ? (
                      <span class="relay-source-url" title={status.url}>
                        {status.url}
                      </span>
                    ) : null}
                  </div>
                  <span class={['relay-badge', `relay-badge-${status.state}`]}>
                    {stateKey !== undefined ? t(stateKey) : status.state}
                  </span>
                  {/* D1：选中标识（连接徽章表达链路状态，本徽章表达选择状态，二者独立） */}
                  {isSelected ? (
                    <span class="relay-badge relay-badge-selected">{t('ds.summary.selected')}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      );
    };
  },
});
