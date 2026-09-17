// 远程智能体（A2A）管理区块（components/，2026-09-14 解耦改造）—— 列表页 + 独立子页面。
//
// 页面形态：
// - list（默认）→ 只读卡片列表（行级操作：测试连通 / 编辑 / 删除）+「新增绑定」入口
//   + 保存按钮（草稿 + 显式保存，与设置页同范式；dirty 时可用）
// - add → SubPageFrame「新增绑定」子页面（返回 icon 回列表；提交只落草稿）
// - edit → SubPageFrame「编辑绑定 · <id>」子页面（cardUrl/端点覆盖/token/启停；提交只落草稿）
// 两个子页面复用同一 A2aBindingForm（mode: 'add' | 'edit'），提交统一 commitRef upsert
// （存在 = 单条替换，不存在 = 追加），由宿主页面（A2aPage）应用到草稿。
// 数据归属：全局 A2A 配置持久化在 chrome.storage.local 的 a2aConfig（经 A2aPage 草稿
// → App handleSaveA2aConfig 落盘）；token 在 a2aTokens 键，随保存整批落盘 ——
// 本组件零 chrome.*，全部经 props/emits/函数 prop 与宿主交互。
// 决策（2026-09-12）：agentKey（id）一经创建不可变，UI 不提供 id 编辑（改 URL 不改名）。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { defineComponent, ref, type PropType } from 'vue';
import type { AgentA2aRef } from 'webmcp-agent-chat-core';
import { t } from '../i18n';
import { SubPageFrame } from './SubPageFrame';
import { A2aBindingForm, type A2aFormPayload } from './a2a/A2aBindingForm';
import { A2aBindingList } from './a2a/A2aBindingList';

export const A2aAgentsSection = defineComponent({
  name: 'A2aAgentsSection',
  props: {
    /** 全局 A2A 配置草稿（宿主页 A2aPage 持有，本组件只读 + 事件上报变更）。 */
    refs: { type: Array as PropType<AgentA2aRef[]>, required: true },
    /** agentId → bearer token 草稿（App a2aTokens 响应式快照）。 */
    a2aTokens: { type: Object as PropType<Record<string, string>>, required: true },
    busy: { type: Boolean, required: true },
    /** App 侧保存进行中（保存按钮防重复提交）。 */
    saving: { type: Boolean, required: true },
    /** 草稿是否偏离基线（保存按钮可用态）。 */
    dirty: { type: Boolean, required: true },
    /** 连通测试（App 委托 a2a-host.testConnection，按协议分派，返回结果文案）。 */
    testConnection: {
      type: Function as PropType<(refItem: AgentA2aRef, token?: string) => Promise<string>>,
      required: true,
    },
    /** App 层全局提示（持久化失败等；null = 无提示）。 */
    notice: {
      type: Object as PropType<{ kind: 'error' | 'ok'; text: string } | null>,
      default: null,
    },
  },
  emits: {
    /** 表单提交（新增/编辑统一 upsert）：条目 + token 交宿主页落草稿。 */
    commitRef: (refItem: AgentA2aRef, _token: string) =>
      typeof refItem?.id === 'string' && refItem.id.length > 0,
    /** 行级删除（两步确认后触发；仅落草稿）。 */
    removeRef: (id: string) => id.length > 0,
    /** 显式保存（整批提交草稿）。 */
    save: null,
  },
  setup(props, { emit }) {
    /** 页面形态：list = 只读列表；add/edit = 独立子页面（跨页签切换保留）。 */
    const view = ref<'list' | 'add' | 'edit'>('list');
    /** 编辑态目标条目 id（view === 'edit' 时有效）。 */
    const editingId = ref('');

    const openEdit = (id: string): void => {
      editingId.value = id;
      view.value = 'edit';
    };

    const backToList = (): void => {
      view.value = 'list';
      editingId.value = '';
    };

    // ---- 表单子页面提交（新增/编辑统一 upsert；按协议归一化后交宿主落草稿）----

    const handleFormSubmit = (payload: A2aFormPayload): void => {
      const base = { id: payload.id, enabled: payload.enabled };
      let refItem: AgentA2aRef;
      if (payload.protocol === 'dify') {
        // dify 条目：endpoint 必填，可选字段空串 = 未填写（字段移除语义）
        refItem = { ...base, protocol: 'dify', endpoint: payload.endpoint, responseMode: payload.responseMode };
        if (payload.displayName.length > 0) refItem.displayName = payload.displayName;
        if (payload.description.length > 0) refItem.description = payload.description;
        if (payload.inputsJson.length > 0) refItem.inputs = JSON.parse(payload.inputsJson) as Record<string, unknown>;
      } else {
        // jsonrpc 条目（现状语义）：cardUrl 必填，端点覆盖空串 = 未覆盖（回落卡片接口地址）
        refItem = { ...base, cardUrl: payload.cardUrl };
        const trimmed = payload.endpointOverride.trim();
        if (trimmed.length > 0) refItem.endpointOverride = trimmed;
      }
      emit('commitRef', refItem, payload.token);
      backToList();
    };

    return () => {
      // A8：全局 notice 升级为卡片（边框 + 左缘状态条），失败/成功视觉分级
      const noticeNode =
        props.notice !== null ? (
          <p class={props.notice.kind === 'error' ? 'settings-notice settings-notice-error' : 'settings-notice settings-notice-ok'}>
            {props.notice.text}
          </p>
        ) : null;

      // ---- 新增子页面（独立页面：返回 icon + 标题栏）----
      if (view.value === 'add') {
        return (
          <div class="settings-a2a">
            <SubPageFrame title={t('a2a.add.title')} onBack={() => backToList()}>
              {noticeNode}
              <A2aBindingForm
                mode="add"
                refs={props.refs}
                busy={props.busy}
                onSubmit={(payload: A2aFormPayload) => handleFormSubmit(payload)}
              />
            </SubPageFrame>
          </div>
        );
      }

      // ---- 编辑子页面（单条：返回 icon + 标题栏）----
      if (view.value === 'edit') {
        const editingItem = props.refs.find((item) => item.id === editingId.value) ?? null;
        return (
          <div class="settings-a2a">
            <SubPageFrame title={t('a2a.editItemTitle', { id: editingId.value })} onBack={() => backToList()}>
              {noticeNode}
              {editingItem === null ? (
                <p class="settings-hint">{t('a2a.noBindings')}</p>
              ) : (
                <A2aBindingForm
                  mode="edit"
                  item={editingItem}
                  token={props.a2aTokens[editingItem.id] ?? ''}
                  busy={props.busy}
                  onSubmit={(payload: A2aFormPayload) => handleFormSubmit(payload)}
                  onCancel={() => backToList()}
                />
              )}
            </SubPageFrame>
          </div>
        );
      }

      // ---- 列表页（默认：只读卡片 + 行级操作 + 新增入口 + 草稿保存）----
      return (
        <div class="settings-a2a">
          <p class="settings-hint">{t('a2a.hint')}</p>
          {noticeNode}
          <A2aBindingList
            refs={props.refs}
            a2aTokens={props.a2aTokens}
            testConnection={props.testConnection}
            onEdit={(id: string) => openEdit(id)}
            onRemove={(id: string) => emit('removeRef', id)}
            // A6 空态 CTA：从列表页直接进入新增子页面
            onAdd={() => {
              view.value = 'add';
            }}
          />
          <div class="page-mode-actions">
            <button
              type="button"
              disabled={props.busy || props.saving}
              onClick={() => {
                view.value = 'add';
              }}
            >
              {t('a2a.add.title')}
            </button>
            <button
              type="button"
              disabled={props.busy || props.saving || !props.dirty}
              onClick={() => emit('save')}
            >
              {props.saving ? t('a2a.saving') : t('common.save')}
            </button>
          </div>
          {props.dirty ? <p class="settings-hint">{t('a2a.unsavedHint')}</p> : null}
        </div>
      );
    };
  },
});
