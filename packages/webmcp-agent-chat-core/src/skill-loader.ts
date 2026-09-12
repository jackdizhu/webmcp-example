// 技能渐进加载领域模块（共享库 webmcp-agent-chat-core，P2）。
//
// 职责：skills 两级注入（progressive disclosure）的领域逻辑收口 ——
// L1 技能描述清单生成（Token 预算 + 超限截断说明，D3）、L2 技能加载工具定义与结果包装、
// 内容解析编排（storage 覆写 → 内置 assets → 缺失报错，D2）、关键词预触发匹配（可选）。
//
// 边界红线：纯函数/纯数据，零 Vue、零 chrome.*、零宿主依赖（C7/C8）；
// 内容的「读取实现」（assets 打包数据 / storage 覆写）由宿主注入（SkillResolverDeps）。
import type { AgentTool } from './agent-loop';

/** 技能摘要（L1 清单条目；keywords 用于可选的关键词预触发）。 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
}

/** 技能完整定义（SKILL.md 形态：摘要 + 全文内容）。 */
export interface SkillDefinition extends SkillSummary {
  content: string;
}

/** L1 技能描述清单的 Token 预算上限（D3 决策：100,000 tokens）。 */
export const SKILL_L1_TOKEN_BUDGET = 100_000;

/**
 * L2 技能加载工具名：双下划线前缀，与页面动态注册的工具（tab<id>__ / 业务命名）明确区分。
 * 注意：这是「加载技能」这个工具的名称；SKILL 的唯一标识是技能 id（如 page-tools-guide），
 * UI 展示 SKILL 调用记录时应显示技能 id（宿主经 callTool 缝捕获）。
 */
export const SKILL_TOOL_NAME = '__agent_load_skill';

/**
 * Token 估算（纯函数，启发式）：CJK 字符 ≈ 1 token/字；其余字符 ≈ 4 字符/token。
 * 仅用于 L1 预算控制，不追求精确（精确计数需 tokenizer，体积不可接受）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 生成 L1 技能描述清单段（按序累计估算 tokens，超预算截断并追加截断说明行）。
 *
 * 输出形态：
 *   [skills]
 *   以下为可用技能清单（需要全文时调用 __agent_load_skill 工具并传入技能 id）：
 *   - <name>（id: <id>）：<description>
 *   ...
 *   …(技能描述清单超出 Token 预算（上限 N tokens），剩余 M 个技能未收录)
 *
 * 空列表返回空串（调用方据此省略该段）。
 */
export function buildSkillL1Section(
  summaries: SkillSummary[],
  budgetTokens: number = SKILL_L1_TOKEN_BUDGET
): string {
  if (summaries.length === 0) return '';
  const header = [
    '[skills]',
    `以下为可用技能清单（需要全文时调用 ${SKILL_TOOL_NAME} 工具并传入技能 id）：`,
  ];
  const entries: string[] = [];
  let usedTokens = 0;
  let truncatedCount = 0;
  for (let index = 0; index < summaries.length; index += 1) {
    const summary = summaries[index]!;
    const line = `- ${summary.name}（id: ${summary.id}）：${summary.description}`;
    const cost = estimateTokens(line) + 1; // +1 = 条目间换行
    // 首条无条件收录（保证清单非空）；后续条目按序累计，超预算即截断
    if (entries.length > 0 && usedTokens + cost > budgetTokens) {
      truncatedCount = summaries.length - entries.length;
      break;
    }
    entries.push(line);
    usedTokens += cost;
  }
  const lines = [...header, ...entries];
  if (truncatedCount > 0) {
    lines.push(`…(技能描述清单超出 Token 预算（上限 ${budgetTokens} tokens），剩余 ${truncatedCount} 个技能未收录)`);
  }
  return lines.join('\n');
}

/**
 * L2 技能加载工具定义（静态；执行由宿主 callTool 缝路由到 resolver）。
 */
export function createSkillToolDefinition(): AgentTool {
  return {
    name: SKILL_TOOL_NAME,
    description: '加载技能全文：传入技能 id（见系统提示词 [skills] 清单），返回该技能的完整内容。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '技能 id（来自系统提示词技能清单）' },
      },
      required: ['id'],
    },
  };
}

/** 校验并取出技能加载工具的 id 入参；非法时抛错（调用方包装为 isError 结果）。 */
export function parseSkillToolArgs(args: Record<string, unknown>): string {
  const id = args['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`${SKILL_TOOL_NAME} 入参缺少有效的技能 id（string）`);
  }
  return id.trim();
}

/** 技能工具结果（MCP CallToolResult 同构，与内置工具/页面工具形状一致）。 */
export interface SkillToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

/** 技能全文 → 成功结果（内容带 id/name 头部，便于模型定位）。 */
export function toSkillToolResult(definition: SkillDefinition): SkillToolResult {
  return {
    content: [{ type: 'text', text: `# ${definition.name}（id: ${definition.id}）\n\n${definition.content}` }],
    isError: false,
  };
}

/** 技能加载失败 → 错误结果（isError: true，文本承载原因）。 */
export function toSkillToolError(message: string): SkillToolResult {
  return {
    content: [{ type: 'text', text: `技能加载失败：${message}` }],
    isError: true,
  };
}

/** 内容解析依赖（宿主注入读取实现：覆写源 / 内置 assets 源）。 */
export interface SkillResolverDeps {
  /** storage 覆写源：返回 null = 该 id 无覆写。 */
  loadOverride(id: string): Promise<SkillDefinition | null>;
  /** 内置 assets 源：返回 null = 该 id 无内置技能。 */
  loadAsset(id: string): Promise<SkillDefinition | null>;
}

export interface SkillResolver {
  /** 解析技能全文；两级源都未命中时抛错（调用方包装为 isError 结果）。 */
  resolve(id: string): Promise<SkillDefinition>;
}

/**
 * 内容解析编排（D2 决策）：storage 覆写优先 → 内置 assets → 缺失报错。
 * 容错：覆写源读取异常视同无覆写（不阻断 assets 兜底）。
 */
export function createSkillResolver(deps: SkillResolverDeps): SkillResolver {
  return {
    async resolve(id) {
      let override: SkillDefinition | null = null;
      try {
        override = await deps.loadOverride(id);
      } catch {
        override = null;
      }
      if (override !== null && override.id === id) return override;
      const asset = await deps.loadAsset(id);
      if (asset !== null) return asset;
      throw new Error(`技能不存在：${id}`);
    },
  };
}

/**
 * 关键词预触发匹配（可选优化，P2 默认不接线）：用户消息命中技能 keywords 时返回其 id 列表，
 * 宿主可据此把这些技能全文直接注入（牺牲 Token 换少一轮工具调用）。
 */
export function matchSkillTriggers(userText: string, summaries: SkillSummary[]): string[] {
  return summaries
    .filter((summary) => (summary.keywords ?? []).some((keyword) => keyword.length > 0 && userText.includes(keyword)))
    .map((summary) => summary.id);
}
