// 远程智能体（A2A）管理区块（components/，P0）。
//
// 职责：激活智能体的 a2aAgents 列表管理（增删/启停）+ 每条目的 token 编辑与连通测试。
// 数据归属：a2aAgents 持久化在 profile（经 App 落 profileStore）；token 持久化在
// chrome.storage.local 的 a2aTokens（经 App 落 a2a-host）——本组件零 chrome.*，
// 全部经 props/emits/函数 prop 与宿主交互（分层约定：独立组件不感知页面路由）。
// 决策（2026-09-12）：agentKey（id）一经创建不可变，UI 不提供 id 编辑（改 URL 不改名）。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止运行时字符串编译，见 issues/001）。
import { defineComponent, h, ref, type PropType } from 'vue';
import { isHttpUrl, validateA2aAgentId, type AgentA2aRef } from 'webmcp-agent-chat-core';

export const A2aAgentsSection = defineComponent({
  name: 'A2aAgentsSection',
  props: {
    /** 全部智能体档案（编辑目标经 targetAgentId 选择）。 */
    agents: { type: Array as PropType<Array<{ id: string; name: string; a2aAgents: AgentA2aRef[] }>>, required: true },
    activeAgentId: { type: String, required: true },
    /** 当前编辑目标智能体 id（默认跟随激活智能体，可手动切换；绑定按目标分别持久化）。 */
    targetAgentId: { type: String, required: true },
    /** agentId → bearer token（App 从 a2aTokens 存储加载的响应式快照）。 */
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
    // ---- 新增表单（本地状态） ----
    const newId = ref('');
    const newCardUrl = ref('');
    const newEndpoint = ref('');
    const newToken = ref('');
    const formError = ref('');
    /** 最近一次成功提示（自动清除，避免旧提示残留误导）。 */
    const formSuccess = ref('');
    let formSuccessTimer: ReturnType<typeof setTimeout> | null = null;
    /** 每条目的连通测试结果（agentId → 文案）。 */
    const testResults = ref<Record<string, string>>({});
    /** 进行中的连通测试 agentId 集合。 */
    const testing = ref<Set<string>>(new Set());

    /** 当前编辑目标智能体（按 targetAgentId 查找；不存在 = null，由 UI 提示）。 */
    const targetAgent = (): { id: string; name: string; a2aAgents: AgentA2aRef[] } | null =>
      props.agents.find((agent) => agent.id === props.targetAgentId) ?? null;

    const handleTest = async (agentId: string, cardUrl: string): Promise<void> => {
      if (testing.value.has(agentId)) return;
      testing.value = new Set([...testing.value, agentId]);
      try {
        const message = await props.testConnection(cardUrl, props.a2aTokens[agentId]);
        testResults.value = { ...testResults.value, [agentId]: message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        testResults.value = { ...testResults.value, [agentId]: `连通测试失败：${message}` };
      } finally {
        const next = new Set(testing.value);
        next.delete(agentId);
        testing.value = next;
      }
    };

    const handleAdd = (): void => {
      formError.value = '';
      setFormSuccess('');
      const id = newId.value.trim();
      const cardUrl = newCardUrl.value.trim();
      try {
        validateA2aAgentId(id);
      } catch {
        formError.value = 'ID 非法：仅允许字母、数字、下划线、连字符（创建后不可修改）。';
        return;
      }
      if (cardUrl.length === 0 || !isHttpUrl(cardUrl)) {
        formError.value = '卡片地址必须是合法的 HTTP(S) URL（通常为 /.well-known/agent-card.json）。';
        return;
      }
      const agent = targetAgent();
      if (agent === null) {
        formError.value = '当前没有激活的智能体。';
        return;
      }
      if (agent.a2aAgents.some((ref) => ref.id === id)) {
        formError.value = `ID「${id}」已存在（agentKey 创建后不可变，如需更换地址请直接编辑卡片地址）。`;
        return;
      }
      const next: AgentA2aRef[] = [
        ...agent.a2aAgents,
        {
          id,
          cardUrl,
          enabled: true,
          ...(newEndpoint.value.trim().length > 0 ? { endpointOverride: newEndpoint.value.trim() } : {}),
        },
      ];
      emit('update:a2aAgents', next);
      emit('save:token', id, newToken.value.trim());
      newId.value = '';
      newCardUrl.value = '';
      newEndpoint.value = '';
      newToken.value = '';
      setFormSuccess(
        `已为「${agent.name}」添加「${id}」并启用。` +
          (props.targetAgentId === props.activeAgentId
            ? `对话中将以 a2a__${id}__send_task 工具可用。`
            : '注意：编辑目标不是当前激活智能体，对话中生效的是激活智能体的绑定。')
      );
    };

    /** 成功提示 6 秒自动清除（重复操作时重置计时）。 */
    const setFormSuccess = (text: string): void => {
      formSuccess.value = text;
      if (formSuccessTimer !== null) clearTimeout(formSuccessTimer);
      formSuccessTimer =
        text.length > 0
          ? setTimeout(() => {
              formSuccess.value = '';
              formSuccessTimer = null;
            }, 6000)
          : null;
    };

    const handleToggle = (refItem: AgentA2aRef, enabled: boolean): void => {
      const agent = targetAgent();
      if (agent === null) return;
      emit(
        'update:a2aAgents',
        agent.a2aAgents.map((ref) => (ref.id === refItem.id ? { ...ref, enabled } : ref))
      );
    };

    const handleRemove = (refItem: AgentA2aRef): void => {
      const agent = targetAgent();
      if (agent === null) return;
      emit(
        'update:a2aAgents',
        agent.a2aAgents.filter((ref) => ref.id !== refItem.id)
      );
    };

    const handleCardUrlChange = (refItem: AgentA2aRef, cardUrl: string): void => {
      const agent = targetAgent();
      if (agent === null || !isHttpUrl(cardUrl.trim())) return;
      emit(
        'update:a2aAgents',
        agent.a2aAgents.map((ref) => (ref.id === refItem.id ? { ...ref, cardUrl: cardUrl.trim() } : ref))
      );
    };

    /** 端点覆盖：留空 = 清除覆盖（回落卡片接口地址）。 */
    const handleEndpointChange = (refItem: AgentA2aRef, endpoint: string): void => {
      const agent = targetAgent();
      if (agent === null) return;
      const trimmed = endpoint.trim();
      emit(
        'update:a2aAgents',
        agent.a2aAgents.map((ref) =>
          ref.id === refItem.id
            ? trimmed.length > 0
              ? { ...ref, endpointOverride: trimmed }
              : { id: ref.id, cardUrl: ref.cardUrl, enabled: ref.enabled }
            : ref
        )
      );
    };

    return () => {
      const agent = targetAgent();
      const rows = (agent?.a2aAgents ?? []).map((refItem) =>
        h('div', { class: ['a2a-item', refItem.enabled ? '' : 'a2a-item-off'], key: refItem.id }, [
          h('div', { class: 'a2a-item-head' }, [
            h('input', {
              type: 'checkbox',
              checked: refItem.enabled,
              title: '启用后该远程智能体以 a2a__<id>__send_task 工具暴露给对话',
              onChange: (event: Event) => handleToggle(refItem, (event.target as HTMLInputElement).checked),
            }),
            h('span', { class: 'a2a-item-id', title: refItem.id }, refItem.id),
            h('button', {
              class: 'ghost',
              type: 'button',
              disabled: testing.value.has(refItem.id),
              onClick: () => void handleTest(refItem.id, refItem.cardUrl),
            }, testing.value.has(refItem.id) ? '测试中…' : '测试连通'),
            h('button', { class: 'ghost', type: 'button', onClick: () => handleRemove(refItem) }, '删除'),
          ]),
          h('input', {
            type: 'url',
            value: refItem.cardUrl,
            placeholder: 'https://example.com/.well-known/agent-card.json',
            onChange: (event: Event) => handleCardUrlChange(refItem, (event.target as HTMLInputElement).value),
          }),
          h('input', {
            type: 'url',
            value: refItem.endpointOverride ?? '',
            placeholder: 'JSON-RPC 端点覆盖（可选，默认用卡片接口地址；如 Dify 填 http://host/e/<app>/a2a）',
            onChange: (event: Event) => handleEndpointChange(refItem, (event.target as HTMLInputElement).value),
          }),
          h('input', {
            type: 'password',
            placeholder: `${refItem.id} 的 bearer token（可留空）`,
            autocomplete: 'off',
            value: props.a2aTokens[refItem.id] ?? '',
            // onChange（失焦/回车）才保存：onInput 每键都会全量重写 a2aTokens 存储
            // 并触发 a2aHost.sync（含卡片抓取网络请求），输入过程会形成写入/请求风暴
            onChange: (event: Event) => {
              emit('save:token', refItem.id, (event.target as HTMLInputElement).value);
            },
          }),
          testResults.value[refItem.id] ? h('p', { class: 'settings-hint' }, testResults.value[refItem.id]!) : null,
        ])
      );

      return h('div', { class: 'settings-a2a' }, [
        h('p', { class: 'settings-hint' }, [
          '远程智能体（A2A）：为智能体绑定远程 A2A agent。启用者以 a2a__<id>__send_task 工具暴露给对话，',
          'agent 据卡片描述自动委派任务；ID 创建后不可修改。绑定关系按智能体分别持久化 —— 切换下方目标后需分别绑定。',
        ]),
        // 编辑目标选择器：绑定 per-agent 持久化，切换目标可查看/编辑各自绑定
        // （默认跟随激活智能体；激活变化时由 App 重置回跟随）
        h('div', { class: 'a2a-item-head' }, [
          h('label', { class: 'a2a-item-id', for: 'a2a-target-agent' }, '编辑目标智能体'),
          h(
            'select',
            {
              id: 'a2a-target-agent',
              value: props.targetAgentId,
              onChange: (event: Event) => {
                emit('update:targetAgentId', (event.target as HTMLSelectElement).value);
              },
            },
            props.agents.map((agent) =>
              h(
                'option',
                { value: agent.id, key: agent.id },
                agent.id === props.activeAgentId ? `${agent.name}（当前激活）` : agent.name
              )
            )
          ),
          props.targetAgentId !== props.activeAgentId
            ? h('span', { class: 'settings-hint' }, '⚠ 编辑目标不是当前激活智能体：对话中生效的是「激活智能体」的绑定')
            : null,
        ]),
        props.notice !== null
          ? h(
              'p',
              { class: props.notice.kind === 'error' ? 'settings-hint settings-hint-error' : 'settings-hint settings-hint-ok' },
              props.notice.text
            )
          : null,
        ...(rows.length > 0 ? rows : [h('p', { class: 'settings-hint' }, '暂未绑定远程智能体。')]),
        h('div', { class: 'a2a-add-form' }, [
          h('h4', '新增绑定'),
          h('input', {
            type: 'text',
            placeholder: 'ID（agentKey，仅字母/数字/下划线/连字符，创建后不可改）',
            value: newId.value,
            onInput: (event: Event) => {
              newId.value = (event.target as HTMLInputElement).value;
            },
          }),
          h('input', {
            type: 'url',
            placeholder: 'Agent Card 地址（https://…/.well-known/agent-card.json）',
            value: newCardUrl.value,
            onInput: (event: Event) => {
              newCardUrl.value = (event.target as HTMLInputElement).value;
            },
          }),
          h('input', {
            type: 'url',
            placeholder: 'JSON-RPC 端点覆盖（可选，默认用卡片接口地址；如 Dify 填 http://host/e/<app>/a2a）',
            value: newEndpoint.value,
            onInput: (event: Event) => {
              newEndpoint.value = (event.target as HTMLInputElement).value;
            },
          }),
          h('input', {
            type: 'password',
            placeholder: 'Bearer Token（可留空）',
            autocomplete: 'off',
            value: newToken.value,
            onInput: (event: Event) => {
              newToken.value = (event.target as HTMLInputElement).value;
            },
          }),
          formError.value ? h('p', { class: 'settings-hint settings-hint-error' }, formError.value) : null,
          formSuccess.value ? h('p', { class: 'settings-hint settings-hint-ok' }, formSuccess.value) : null,
          h('button', { type: 'button', disabled: props.busy, onClick: () => handleAdd() }, '添加并启用'),
        ]),
      ]);
    };
  },
});
