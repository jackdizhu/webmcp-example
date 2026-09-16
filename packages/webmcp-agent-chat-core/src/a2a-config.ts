// 全局 A2A 远程智能体配置领域模块（2026-09-14 解耦改造；2026-09-16 协议配置扩展）。
//
// 职责：A2A 远程智能体引用（AgentA2aRef）的类型定义、运行时校验（整表严格校验，
// 供宿主 load/save 收口使用）与防御式净化（逐条过滤非法条目，供旧档案迁移使用）。
// 决策：A2A 配置不再挂在 AgentProfile.a2aAgents 上（per-agent 绑定导致工具清单随
// 激活智能体漂移，且寄生在 agentProfiles 内受其 schema 校验牵连——校验失败重建会
// 连带清空绑定）。现独立为全局单份配置，由宿主持久化到独立存储键。
//
// 协议配置扩展（2026-09-16）：条目级 protocol 字段（'jsonrpc' | 'dify'）——
// - jsonrpc（缺省，向后兼容）：A2A JSON-RPC 2.0，cardUrl 必填（卡片发现）；
// - dify：Dify REST API（POST chat-messages，Bearer api-key），endpoint 必填、
//   cardUrl 不适用；displayName/description 供无卡片场景构建工具清单。
// 校验按 protocol 分支：未知协议值 / 缺失对应必填字段一律 fail（存储数据不可信）。
//
// 边界红线：纯函数/纯类型，零 Vue、零 chrome.*、零宿主模块依赖（C7/C8）。

/** 条目级远端协议类型（缺省 'jsonrpc'，旧数据零迁移）。 */
export type AgentA2aProtocol = 'jsonrpc' | 'dify';

/** Dify 响应模式（请求体 response_mode；缺省 'streaming'——旧版 Agent 应用 blocking 会 400）。 */
export type AgentA2aResponseMode = 'streaming' | 'blocking';

/**
 * 单个远程智能体引用（原 AgentProfile.a2aAgents 条目，2026-09-14 迁出为全局配置）。
 *
 * 决策（2026-09-12）：id（agentKey）一经创建不可变、仅连接信息可改 —— 工具名
 * `<prefix><id>__send_task` 随 id 稳定，不随 URL 漂移（前缀随 protocol：jsonrpc =
 * `a2a__`，dify = `a2a_dify__`）。id 语义约束见 a2a-tool-source 的 validateA2aAgentId
 * （仅 [a-zA-Z0-9_-]）。凭据（bearer token / Dify api-key）不入配置
 * （对齐「apiKey 不允许覆写」的安全立场），由宿主独立存储键持有。
 */
export interface AgentA2aRef {
  id: string;
  /**
   * Agent Card 地址（protocol='jsonrpc' 时必填，GET /.well-known/agent-card.json）。
   * protocol='dify' 时不适用（无卡片发现），可缺省。
   */
  cardUrl?: string;
  enabled: boolean;
  /** 条目协议类型；缺省 'jsonrpc'（旧数据无此字段，语义不变）。 */
  protocol?: AgentA2aProtocol;
  /**
   * JSON-RPC 端点覆盖（可选，仅 jsonrpc）：message/send 与 tasks/get 的 POST 地址。
   * 缺省用卡片 supportedInterfaces[0].url；Dify 等实现的卡片顶层 url 指向聊天页
   * 而非 A2A 端点时，需显式覆盖（如 http://host/e/<app>/a2a）。
   */
  endpointOverride?: string;
  /** Dify chat-messages 完整地址（protocol='dify' 时必填，如 https://host/v1/chat-messages）。 */
  endpoint?: string;
  /** Dify 响应模式（可选）；缺省 'streaming'。 */
  responseMode?: AgentA2aResponseMode;
  /** Dify 工具展示名（可选；无卡片场景的工具清单数据源，缺省用 id）。 */
  displayName?: string;
  /** Dify 工具描述（可选；拼入工具 description，帮助模型选型，缺省占位文案）。 */
  description?: string;
  /** Dify Chatflow inputs 默认值（可选；缺省 {}，请求时与 query/response_mode/user 一起发送）。 */
  inputs?: Record<string, unknown>;
}

/** 协议判定：缺省 jsonrpc（旧数据零迁移）。 */
export function a2aRefProtocol(ref: Pick<AgentA2aRef, 'protocol'>): AgentA2aProtocol {
  return ref.protocol ?? 'jsonrpc';
}

/** responseMode 合法值（校验与 UI 共用）。 */
const RESPONSE_MODES: readonly string[] = ['streaming', 'blocking'];

/** inputs 合法性：普通对象（非 null/非数组；值不深检，落盘前经 JSON 序列化对齐）。 */
function isValidInputs(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 运行时校验全局 A2A 配置（存储数据不可信）。
 * 抛错时携带首个违规点描述；调用方（宿主 store）捕获后先备份脏数据再重建。
 */
export function validateA2aConfigValue(value: unknown): AgentA2aRef[] {
  const fail = (reason: string): never => {
    throw new Error(`invalid a2a config: ${reason}`);
  };
  if (!Array.isArray(value)) fail('root is not an array');
  for (const ref of value as unknown[]) {
    const r = ref as Record<string, unknown>;
    const shapeOk =
      typeof r === 'object' &&
      r !== null &&
      typeof r['id'] === 'string' &&
      r['id'].length > 0 &&
      typeof r['enabled'] === 'boolean';
    if (!shapeOk) fail('refs has an invalid entry');
    // 协议字段：缺省 jsonrpc；显式值仅允许两个合法枚举
    const protocol = r['protocol'];
    if (protocol !== undefined && protocol !== 'jsonrpc' && protocol !== 'dify') {
      fail('refs has an invalid entry');
    }
    if (protocol === 'dify') {
      // dify 条目：endpoint 必填；responseMode/displayName/description/inputs 可选
      const responseMode = r['responseMode'];
      const difyOk =
        typeof r['endpoint'] === 'string' &&
        (r['endpoint'] as string).length > 0 &&
        (responseMode === undefined ||
          (typeof responseMode === 'string' && RESPONSE_MODES.includes(responseMode))) &&
        (r['displayName'] === undefined || typeof r['displayName'] === 'string') &&
        (r['description'] === undefined || typeof r['description'] === 'string') &&
        (r['inputs'] === undefined || isValidInputs(r['inputs']));
      if (!difyOk) fail('refs has an invalid entry');
    } else {
      // jsonrpc 条目（现状）：cardUrl 必填；endpointOverride 可选
      const endpointOverride = r['endpointOverride'];
      const jsonrpcOk =
        typeof r['cardUrl'] === 'string' &&
        (r['cardUrl'] as string).length > 0 &&
        (endpointOverride === undefined ||
          (typeof endpointOverride === 'string' && (endpointOverride as string).length > 0));
      if (!jsonrpcOk) fail('refs has an invalid entry');
    }
  }
  return value as AgentA2aRef[];
}

/**
 * 防御式净化：从不可信的旧档案数据中逐条提取合法引用（不抛错）。
 * 用途：一次性迁移（agentProfiles.agents[i].a2aAgents → 全局 a2aConfig）。
 * 非法条目静默丢弃并返回丢弃数（宿主可据此打日志）；id 重复时保留首个。
 */
export function sanitizeA2aRefs(value: unknown): { refs: AgentA2aRef[]; dropped: number } {
  if (!Array.isArray(value)) return { refs: [], dropped: 0 };
  const seen = new Set<string>();
  const refs: AgentA2aRef[] = [];
  let dropped = 0;
  for (const ref of value as unknown[]) {
    if (typeof ref !== 'object' || ref === null) {
      dropped += 1;
      continue;
    }
    const r = ref as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || r['id'].length === 0 || typeof r['enabled'] !== 'boolean') {
      dropped += 1;
      continue;
    }
    if (seen.has(r['id'])) {
      dropped += 1;
      continue;
    }
    const protocol = r['protocol'];
    if (protocol !== undefined && protocol !== 'jsonrpc' && protocol !== 'dify') {
      dropped += 1;
      continue;
    }
    if (protocol === 'dify') {
      // dify 条目：endpoint 必填；可选字段类型不符即丢弃该条目
      const endpoint = r['endpoint'];
      const responseMode = r['responseMode'];
      const displayName = r['displayName'];
      const description = r['description'];
      const inputs = r['inputs'];
      const valid =
        typeof endpoint === 'string' &&
        endpoint.length > 0 &&
        (responseMode === undefined ||
          (typeof responseMode === 'string' && RESPONSE_MODES.includes(responseMode))) &&
        (displayName === undefined || typeof displayName === 'string') &&
        (description === undefined || typeof description === 'string') &&
        (inputs === undefined || isValidInputs(inputs));
      if (!valid) {
        dropped += 1;
        continue;
      }
      seen.add(r['id']);
      refs.push({
        id: r['id'],
        enabled: r['enabled'],
        protocol: 'dify',
        endpoint,
        ...(responseMode !== undefined ? { responseMode: responseMode as AgentA2aResponseMode } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(inputs !== undefined ? { inputs: inputs as Record<string, unknown> } : {}),
      });
      continue;
    }
    // jsonrpc 条目（现状语义）
    const cardUrl = r['cardUrl'];
    const endpointOverride = r['endpointOverride'];
    const valid =
      typeof cardUrl === 'string' &&
      cardUrl.length > 0 &&
      (endpointOverride === undefined ||
        (typeof endpointOverride === 'string' && endpointOverride.length > 0));
    if (!valid) {
      dropped += 1;
      continue;
    }
    seen.add(r['id']);
    refs.push(
      endpointOverride === undefined
        ? { id: r['id'], cardUrl, enabled: r['enabled'] }
        : { id: r['id'], cardUrl, enabled: r['enabled'], endpointOverride }
    );
  }
  return { refs, dropped };
}
