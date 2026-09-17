// 远程智能体（A2A）设置页（页面功能级，2026-09-14 解耦改造）：维护全局 A2A 配置与
// 连接信息 —— 全局远程 A2A agent 列表（增删/启停/改卡片地址）、每条目的 bearer token
// 编辑与连通测试。配置不再与智能体关联（全局单份，所有智能体共享工具清单）。
// 保存范式与设置页一致：本页持**本地草稿**（refs + tokens），行级操作只改草稿，
// 点「保存」才整批落盘（App handleSaveA2aConfig）并触发工具清单重建。
// 区块本体复用 components/A2aAgentsSection。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { computed, defineComponent, ref, watch, type PropType } from 'vue';
import type { AgentA2aRef } from 'webmcp-agent-chat-core';
import { A2aAgentsSection } from '../components/A2aAgentsSection';

export const A2aPage = defineComponent({
  name: 'A2aPage',
  props: {
    /** 本页是否激活（非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    /** 全局 A2A 配置基线（App a2aConfig；保存成功后草稿按此重置）。 */
    refs: { type: Array as PropType<AgentA2aRef[]>, required: true },
    /** agentId → bearer token（App a2aTokens 响应式对象，基线读取用）。 */
    a2aTokens: { type: Object as PropType<Record<string, string>>, required: true },
    /** 执行锁（对话/relay 进行中）：保存按钮禁用。 */
    busy: { type: Boolean, required: true },
    /** App 侧保存进行中（防重复提交）。 */
    saving: { type: Boolean, required: true },
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
    /** 显式保存：整批提交草稿（App 落盘 a2aConfig + a2aTokens 后回写基线）。 */
    save: (refs: AgentA2aRef[], _tokens: Record<string, string>) => Array.isArray(refs),
  },
  setup(props, { emit }) {
    // ---- 本地草稿态（唯一可写副本；基线变化 = 保存成功/启动加载，草稿随之对齐）----
    const draftRefs = ref<AgentA2aRef[]>([]);
    const draftTokens = ref<Record<string, string>>({});

    watch(
      () => props.refs,
      (refs) => {
        draftRefs.value = refs.map((item) => ({ ...item }));
      },
      { immediate: true }
    );
    // 深度监听基线 token（App 仅在保存成功后原位变更该响应式对象；本页编辑只动草稿，
    // 不会误触发）
    watch(
      () => props.a2aTokens,
      (tokens) => {
        draftTokens.value = { ...tokens };
      },
      { deep: true, immediate: true }
    );

    /** 草稿是否偏离基线（决定保存按钮可用态与未保存提示）。 */
    const dirty = computed(
      () =>
        JSON.stringify(draftRefs.value) !== JSON.stringify(props.refs) ||
        JSON.stringify(draftTokens.value) !== JSON.stringify(props.a2aTokens)
    );

    /** 区块提交（新增/编辑统一 upsert）：条目与 token 都只落草稿，待显式保存。 */
    const handleCommitRef = (refItem: AgentA2aRef, token: string): void => {
      const exists = draftRefs.value.some((item) => item.id === refItem.id);
      draftRefs.value = exists
        ? draftRefs.value.map((item) => (item.id === refItem.id ? refItem : item))
        : [...draftRefs.value, refItem];
      draftTokens.value = { ...draftTokens.value, [refItem.id]: token };
    };

    /** 区块删除（两步确认后）：仅落草稿。 */
    const handleRemoveRef = (id: string): void => {
      draftRefs.value = draftRefs.value.filter((item) => item.id !== id);
    };

    const handleSave = (): void => {
      if (props.busy || props.saving || !dirty.value) return;
      emit('save', draftRefs.value.map((item) => ({ ...item })), { ...draftTokens.value });
    };

    return () => (
      <div class="a2a-page" style={{ display: props.active ? '' : 'none' }}>
        <A2aAgentsSection
          refs={draftRefs.value}
          a2aTokens={draftTokens.value}
          busy={props.busy}
          saving={props.saving}
          dirty={dirty.value}
          testConnection={props.testConnection}
          notice={props.notice}
          onCommitRef={(refItem: AgentA2aRef, token: string) => handleCommitRef(refItem, token)}
          onRemoveRef={(id: string) => handleRemoveRef(id)}
          onSave={() => handleSave()}
        />
      </div>
    );
  },
});
