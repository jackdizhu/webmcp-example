// 远程智能体（A2A）设置页（页面功能级，P0）：维护 a2a 配置与连接信息 ——
// 激活智能体绑定的远程 A2A agent 列表（增删/启停/改卡片地址）、每条目的 bearer token
// 编辑与连通测试。区块本体复用 components/A2aAgentsSection，数据/动作透传 App。
// 独立成页（2026-09-12 页面结构调整）：与 LLM 连接配置（设置页）解耦，A2A 连接管理
// 自成一类，页签与「数据源设置」同级。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, type PropType } from 'vue';
import type { AgentA2aRef } from 'webmcp-agent-chat-core';
import { A2aAgentsSection } from '../components/A2aAgentsSection';

export const A2aPage = defineComponent({
  name: 'A2aPage',
  props: {
    /** 本页是否激活（非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    /** 全部智能体档案（取激活项展示；绑定关系 per-agent 存 profile）。 */
    agents: {
      type: Array as PropType<Array<{ id: string; name: string; a2aAgents: AgentA2aRef[] }>>,
      required: true,
    },
    activeAgentId: { type: String, required: true },
    /** 当前编辑目标智能体 id（默认跟随激活，可手动切换；绑定按目标智能体分别持久化）。 */
    targetAgentId: { type: String, required: true },
    /** agentId → bearer token（App 从 a2aTokens 存储加载的快照）。 */
    a2aTokens: { type: Object as PropType<Record<string, string>>, required: true },
    busy: { type: Boolean, required: true },
    /** 连通测试（App 委托 a2a-host.testConnection），返回结果文案。 */
    testConnection: {
      type: Function as PropType<(cardUrl: string, token?: string) => Promise<string>>,
      required: true,
    },
    /** App 层全局提示（持久化失败等；null = 无提示）。 */
    notice: {
      type: Object as PropType<{ kind: 'error' | 'ok'; text: string } | null>,
      default: null,
    },
  },
  emits: {
    /** 切换编辑目标智能体。 */
    'update:targetAgentId': (id: string) => id.length > 0,
    /** 整表替换目标智能体的 a2aAgents。 */
    'update:a2aAgents': (refs: AgentA2aRef[]) => Array.isArray(refs),
    /** 保存单条 token（agentId 可为尚未添加的待新增 id）。 */
    'save:token': (agentId: string, _token: string) => agentId.length > 0,
  },
  setup(props, { emit }) {
    return () =>
      h('div', { class: 'a2a-page', style: { display: props.active ? '' : 'none' } }, [
        h(A2aAgentsSection, {
          agents: props.agents,
          activeAgentId: props.activeAgentId,
          targetAgentId: props.targetAgentId,
          a2aTokens: props.a2aTokens,
          busy: props.busy,
          testConnection: props.testConnection,
          notice: props.notice,
          'onUpdate:targetAgentId': (id: string) => emit('update:targetAgentId', id),
          'onUpdate:a2aAgents': (refs: AgentA2aRef[]) => emit('update:a2aAgents', refs),
          'onSave:token': (agentId: string, token: string) => emit('save:token', agentId, token),
        }),
      ]);
  },
});
