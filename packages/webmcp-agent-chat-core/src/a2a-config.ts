// 全局 A2A 远程智能体配置领域模块（2026-09-14 解耦改造）。
//
// 职责：A2A 远程智能体引用（AgentA2aRef）的类型定义、运行时校验（整表严格校验，
// 供宿主 load/save 收口使用）与防御式净化（逐条过滤非法条目，供旧档案迁移使用）。
// 决策：A2A 配置不再挂在 AgentProfile.a2aAgents 上（per-agent 绑定导致工具清单随
// 激活智能体漂移，且寄生在 agentProfiles 内受其 schema 校验牵连——校验失败重建会
// 连带清空绑定）。现独立为全局单份配置，由宿主持久化到独立存储键。
//
// 边界红线：纯函数/纯类型，零 Vue、零 chrome.*、零宿主模块依赖（C7/C8）。

/**
 * 单个远程智能体引用（原 AgentProfile.a2aAgents 条目，2026-09-14 迁出为全局配置）。
 *
 * 决策（2026-09-12）：id（agentKey）一经创建不可变、仅 cardUrl 可改 —— 工具名
 * `a2a__<id>__send_task` 随 id 稳定，不随 URL 漂移。id 语义约束见 a2a-tool-source
 * 的 validateA2aAgentId（仅 [a-zA-Z0-9_-]）。bearer token 不入配置
 * （对齐「apiKey 不允许覆写」的安全立场），由宿主独立存储键持有。
 */
export interface AgentA2aRef {
  id: string;
  cardUrl: string;
  enabled: boolean;
  /**
   * JSON-RPC 端点覆盖（可选）：message/send 与 tasks/get 的 POST 地址。
   * 缺省用卡片 supportedInterfaces[0].url；Dify 等实现的卡片顶层 url 指向聊天页
   * 而非 A2A 端点时，需显式覆盖（如 http://host/e/<app>/a2a）。
   */
  endpointOverride?: string;
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
    if (
      typeof r !== 'object' ||
      r === null ||
      typeof r['id'] !== 'string' ||
      r['id'].length === 0 ||
      typeof r['cardUrl'] !== 'string' ||
      r['cardUrl'].length === 0 ||
      typeof r['enabled'] !== 'boolean' ||
      (r['endpointOverride'] !== undefined &&
        (typeof r['endpointOverride'] !== 'string' || (r['endpointOverride'] as string).length === 0))
    ) {
      fail('refs has an invalid entry');
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
    const endpointOverride = r['endpointOverride'];
    const valid =
      typeof r['id'] === 'string' &&
      r['id'].length > 0 &&
      typeof r['cardUrl'] === 'string' &&
      r['cardUrl'].length > 0 &&
      typeof r['enabled'] === 'boolean' &&
      (endpointOverride === undefined ||
        (typeof endpointOverride === 'string' && endpointOverride.length > 0));
    if (!valid) {
      dropped += 1;
      continue;
    }
    if (seen.has(r['id'] as string)) {
      dropped += 1;
      continue;
    }
    seen.add(r['id'] as string);
    refs.push(
      endpointOverride === undefined
        ? { id: r['id'] as string, cardUrl: r['cardUrl'] as string, enabled: r['enabled'] as boolean }
        : {
            id: r['id'] as string,
            cardUrl: r['cardUrl'] as string,
            enabled: r['enabled'] as boolean,
            endpointOverride: endpointOverride as string,
          }
    );
  }
  return { refs, dropped };
}
