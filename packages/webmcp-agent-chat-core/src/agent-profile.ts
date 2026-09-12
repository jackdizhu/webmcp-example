// AgentProfile 领域模块（共享库 webmcp-agent-chat-core）。
//
// 职责：智能体档案的类型定义、运行时校验、rules 分层系统提示词组装、
// per-agent LLM 配置覆写合并、旧版单一 systemPrompt 的幂等迁移、
// Profile 存取接口（宿主用 chrome.storage 等实现）。
//
// 边界红线：纯函数/纯类型，零 Vue、零 chrome.*、零宿主模块依赖（C7）；
// 所有函数不触任何平台 API，可被 vitest 直接覆盖（C8：宿主只调用，不实现领域逻辑）。
import type { LlmConfig } from './llm-client';

/** 单条 agent 级规则。 */
export interface AgentRuleItem {
  id: string;
  text: string;
}

/** agent 级 rules 分层：是否附加全局 rules + agent 自有规则条目。 */
export interface AgentRules {
  /** true = 组装时附加全局 rules 段（settings.systemPrompt 语义）。 */
  inheritGlobal: boolean;
  items: AgentRuleItem[];
}

/** agent 绑定的技能引用（内容解析由 skill-loader 在 P2 提供）。 */
export interface AgentSkillRef {
  id: string;
  enabled: boolean;
}

/** per-agent LLM 配置覆写（缺省字段回落全局 settings；apiKey 不允许覆写）。 */
export interface AgentLlmOverride {
  baseUrl?: string;
  apiPath?: string;
  model?: string;
  apiProtocol?: 'openai-compat' | 'anthropic';
  maxTokens?: number;
}

/** 智能体档案（数据模型见探索文档 §4，mcps 为预留占位）。 */
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  rules: AgentRules;
  skills: AgentSkillRef[];
  /** mcps 预留占位（本期不实现，schema 先占位避免未来迁移）。 */
  mcps: unknown[];
  llmOverride?: AgentLlmOverride;
}

/** Profile 持久化状态（chrome.storage.local 键 agentProfiles 的值形态）。 */
export interface AgentProfilesState {
  agents: AgentProfile[];
  activeAgentId: string;
}

/**
 * Profile 存取接口（core 定义契约，宿主实现平台读写）。
 * 实现方约定：load 对存储中的脏数据应经 validateAgentProfilesState 校验，
 * 校验失败返回 null（交由 migrateLegacySettings 走重建路径）。
 */
export interface ProfileStore {
  load(): Promise<AgentProfilesState | null>;
  save(state: AgentProfilesState): Promise<void>;
}

/** 旧版迁移产物智能体 ID（升级路径的识别标记，新状态不再使用）。 */
export const LEGACY_DEFAULT_AGENT_ID = 'default';

/** 内置默认激活的智能体 ID（用户要求：默认「单个tools调试」）。 */
export const DEFAULT_ACTIVE_AGENT_ID = 'tool-debug';

/**
 * 内置智能体档案（工厂函数：每次返回全新深拷贝，避免调用方共享可变引用）。
 *
 * - 「单个tools调试」：不继承全局提示词，自带单工具约束 —— 每轮最多调用一个工具，
 *   快速验证单个工具行为（默认激活）；
 * - 「多轮循环智能体」：继承全局提示词（= 原完整多轮 tool-use 循环行为），零附加规则。
 */
export function createBuiltinAgentProfiles(): AgentProfile[] {
  return [
    {
      id: 'tool-debug',
      name: '单个tools调试',
      description: '每轮最多调用一个工具，快速验证单个工具行为',
      rules: {
        inheritGlobal: false,
        items: [
          {
            id: 'single-tool-per-turn',
            text: [
              '你是页面工具调试助手，帮助用户逐一验证单个工具的行为。',
              '每轮对话最多调用一个工具：先简要说明要调用的工具与目的，然后调用它；',
              '拿到结果后基于真实返回给出简要结论，随后结束本轮。',
              '除非用户在同一条消息中明确要求连续验证多个工具，否则不要发起第二轮工具调用，也不要多轮循环。',
            ].join(''),
          },
        ],
      },
      skills: [],
      mcps: [],
    },
    {
      id: 'multi-turn-loop',
      name: '多轮循环智能体',
      description: '完整工具集，支持多轮循环调用工具直至完成任务',
      rules: {
        inheritGlobal: true,
        items: [
          {
            id: 'plan-first',
            text: '执行多步任务前，先列出完整计划（步骤清单）再依次执行；每完成一步简要汇报进度，计划需要调整时先说明原因再继续。',
          },
          {
            id: 'stop-on-anomaly',
            text: '发现数据异常（工具返回为空、报错、与预期明显不符或相互矛盾）时，必须立即停止执行，给出问题说明（异常现象与可能原因）并推荐解决方案；在异常澄清之前不要继续调用工具，更不要编造结论。',
          },
        ],
      },
      // P2：绑定内置技能（L1 清单注入 + __agent_load_skill 取全文）；单个tools调试不绑定
      skills: [{ id: 'page-tools-guide', enabled: true }],
      mcps: [],
    },
  ];
}

/** 内置状态的全新拷贝（激活 = 单个tools调试）。 */
function createBuiltinState(): AgentProfilesState {
  return { agents: createBuiltinAgentProfiles(), activeAgentId: DEFAULT_ACTIVE_AGENT_ID };
}

/** 判定 existing 是否为旧版迁移的「未定制默认智能体」（仅一个 id=default 且未加规则），可安全升级。 */
function isPureLegacyDefault(state: AgentProfilesState): boolean {
  return (
    state.agents.length === 1 &&
    state.agents[0] !== undefined &&
    state.agents[0].id === LEGACY_DEFAULT_AGENT_ID &&
    state.agents[0].rules.items.length === 0
  );
}

/**
 * 内置档案条目的原位刷新：existing 中与当前内置定义**同 id 但内容已过时**的条目
 * 替换为最新定义（内置档案由本模块托管，用户如需定制应通过新增自定义智能体）；
 * 自定义条目与被用户删除的内置条目一律不动。
 *
 * 返回 null = 无需更新（所有内置条目已是最新），调用方据此保持引用恒等（幂等不落盘）。
 * 深比较用 JSON 序列化：两侧均出自同一工厂的同构字段序，序列化稳定。
 */
function refreshBuiltinEntries(existing: AgentProfilesState): AgentProfilesState | null {
  const builtins = createBuiltinAgentProfiles();
  let changed = false;
  const nextAgents = existing.agents.map((agent) => {
    const builtin = builtins.find((item) => item.id === agent.id);
    if (!builtin) return agent;
    if (JSON.stringify(agent) === JSON.stringify(builtin)) return agent;
    changed = true;
    return builtin;
  });
  if (!changed) return null;
  const activeValid = nextAgents.some((agent) => agent.id === existing.activeAgentId);
  return { agents: nextAgents, activeAgentId: activeValid ? existing.activeAgentId : DEFAULT_ACTIVE_AGENT_ID };
}

/**
 * 运行时校验存储中的 Profiles 状态（存储数据不可信）。
 * 抛错时携带首个违规点描述；调用方（宿主 store）捕获后回退迁移路径。
 */
export function validateAgentProfilesState(value: unknown): AgentProfilesState {
  const fail = (reason: string): never => {
    throw new Error(`invalid agent profiles state: ${reason}`);
  };
  if (typeof value !== 'object' || value === null) fail('root is not an object');
  const { agents, activeAgentId } = value as Record<string, unknown>;
  if (!Array.isArray(agents)) fail('agents is not an array');
  if (typeof activeAgentId !== 'string') fail('activeAgentId is not a string');
  for (const agent of agents as unknown[]) {
    if (typeof agent !== 'object' || agent === null) fail('agent is not an object');
    const a = agent as Record<string, unknown>;
    if (typeof a['id'] !== 'string' || a['id'].length === 0) fail('agent.id is not a non-empty string');
    if (typeof a['name'] !== 'string' || a['name'].length === 0) fail('agent.name is not a non-empty string');
    if (typeof a['description'] !== 'string') fail('agent.description is not a string');
    const rules = a['rules'];
    if (typeof rules !== 'object' || rules === null) fail(`agent(${a['id']}).rules is not an object`);
    const r = rules as Record<string, unknown>;
    if (typeof r['inheritGlobal'] !== 'boolean') fail(`agent(${a['id']}).rules.inheritGlobal is not a boolean`);
    if (!Array.isArray(r['items'])) fail(`agent(${a['id']}).rules.items is not an array`);
    for (const item of r['items'] as unknown[]) {
      const it = item as Record<string, unknown>;
      if (
        typeof it !== 'object' ||
        it === null ||
        typeof it['id'] !== 'string' ||
        it['id'].length === 0 ||
        typeof it['text'] !== 'string' ||
        it['text'].length === 0
      ) {
        fail(`agent(${a['id']}).rules.items has an invalid entry`);
      }
    }
    if (!Array.isArray(a['skills'])) fail(`agent(${a['id']}).skills is not an array`);
    for (const skill of a['skills'] as unknown[]) {
      const s = skill as Record<string, unknown>;
      if (typeof s !== 'object' || s === null || typeof s['id'] !== 'string' || s['id'].length === 0 || typeof s['enabled'] !== 'boolean') {
        fail(`agent(${a['id']}).skills has an invalid entry`);
      }
    }
    if (!Array.isArray(a['mcps'])) fail(`agent(${a['id']}).mcps is not an array`);
    if (a['llmOverride'] !== undefined && (typeof a['llmOverride'] !== 'object' || a['llmOverride'] === null)) {
      fail(`agent(${a['id']}).llmOverride is not an object`);
    }
  }
  return value as AgentProfilesState;
}

/** 取当前激活的智能体：activeAgentId 未命中时回落第一个；空列表返回 null。 */
export function getActiveAgent(state: AgentProfilesState): AgentProfile | null {
  return state.agents.find((agent) => agent.id === state.activeAgentId) ?? state.agents[0] ?? null;
}

/**
 * rules 分层系统提示词组装。
 *
 * 段结构（带来源标注，供调试页审查最终 prompt）：
 *   [rules:global]
 *   <globalPrompt>
 *
 *   [rules:agent:<agentId>:<ruleId>]
 *   <item text>
 *
 *   [skills]
 *   <L1 技能清单（P2，由 buildSkillL1Section 生成，经 options.skillSection 传入）>
 *
 * 语义：
 * - activeAgent = null（未配置任何智能体）→ 原样返回 trim 后的 globalPrompt（完全兼容存量行为，
 *   忽略 skillSection —— 无智能体即无技能绑定）；
 * - inheritGlobal = false → 跳过 global 段；
 * - 空 global / 空 items / 空 skillSection → 对应段省略；全部为空 → 返回空串（调用方回落 agent-loop 内置默认提示）。
 */
export function composeSystemPrompt(
  activeAgent: AgentProfile | null,
  globalPrompt: string,
  options?: { skillSection?: string }
): string {
  const trimmedGlobal = globalPrompt.trim();
  if (activeAgent === null) return trimmedGlobal;

  const segments: string[] = [];
  if (activeAgent.rules.inheritGlobal && trimmedGlobal.length > 0) {
    segments.push(`[rules:global]\n${trimmedGlobal}`);
  }
  for (const item of activeAgent.rules.items) {
    const text = item.text.trim();
    if (text.length === 0) continue;
    segments.push(`[rules:agent:${activeAgent.id}:${item.id}]\n${text}`);
  }
  const skillSection = options?.skillSection?.trim() ?? '';
  if (skillSection.length > 0) {
    segments.push(skillSection);
  }
  return segments.join('\n\n');
}

/**
 * 合并 per-agent LLM 配置覆写：仅应用「有定义且合法」的字段，其余回落全局 base。
 * 合法性：字符串非空；maxTokens 为正整数；apiProtocol 为两个已知枚举之一。
 */
export function mergeLlmConfig(base: LlmConfig, override?: AgentLlmOverride): LlmConfig {
  if (!override) return base;
  const merged: LlmConfig = { ...base };
  if (typeof override.baseUrl === 'string' && override.baseUrl.trim().length > 0) merged.baseUrl = override.baseUrl;
  if (typeof override.apiPath === 'string' && override.apiPath.trim().length > 0) merged.apiPath = override.apiPath;
  if (typeof override.model === 'string' && override.model.trim().length > 0) merged.model = override.model;
  if (override.apiProtocol === 'openai-compat' || override.apiProtocol === 'anthropic') {
    merged.apiProtocol = override.apiProtocol;
  }
  if (typeof override.maxTokens === 'number' && Number.isInteger(override.maxTokens) && override.maxTokens > 0) {
    merged.maxTokens = override.maxTokens;
  }
  return merged;
}

/**
 * 旧版单一 systemPrompt 的幂等迁移（v5.2：内置双智能体 + rules 补充）：
 * - existing 已含智能体：
 *   - 旧版迁移的「未定制默认智能体」（仅一个 id=default 空规则）→ 升级为内置双智能体；
 *   - 内置条目过时（如多轮循环智能体缺 rules）→ 原位刷新为最新定义（自定义条目不动）；
 *   - 其余情况原样返回（幂等保证：不覆盖用户定制数据、不复活用户删除的内置条目）；
 * - existing 为空 → 创建内置双智能体。
 * 存量 systemPrompt 始终保留在 settings.systemPrompt（全局 rules 语义）。
 */
export function migrateLegacySettings(
  _legacy: { systemPrompt: string },
  existing: AgentProfilesState | null
): AgentProfilesState {
  if (existing !== null && Array.isArray(existing.agents) && existing.agents.length > 0) {
    if (isPureLegacyDefault(existing)) return createBuiltinState();
    return refreshBuiltinEntries(existing) ?? existing;
  }
  return createBuiltinState();
}
