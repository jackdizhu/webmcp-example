// 内置技能资产 + storage 覆写读取（side-panel，P2 落地）。
//
// 职责：D2 决策的宿主读取实现 —— 内置技能随扩展打包（只读 assets 形态，此处为打包期内置清单），
// chrome.storage.local 键 `agentSkillOverrides` 中的同名技能覆写优先（用户可编辑版）。
// 解析编排（覆写 → assets → 缺失报错）在 core 的 createSkillResolver，本模块只提供两个读取函数。
import type { SkillDefinition, SkillSummary } from 'webmcp-agent-chat-core';
import type { ProfileStorageLike } from './agent-profile-store';

/**
 * 内置技能清单（打包期固定；P2 先内置一个指南类技能作为 L1/L2 链路的真实数据源）。
 * content 为 SKILL.md 形态全文。
 */
export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  {
    id: 'page-tools-guide',
    name: '页面工具使用指南',
    description: 'chrome_extension_* 内置工具与页面 WebMCP 工具的组合使用最佳实践',
    keywords: ['工具', '指南', '验证'],
    content: [
      '# 页面工具使用指南',
      '',
      '## 工具全景',
      '- 页面工具：由目标页签通过 WebMCP 注册（跨页签同名工具带 `tab<id>__` 前缀），',
      '  能力随页面动态变化，每轮对话前工具清单会自动刷新。',
      '- 内置工具 `chrome_extension_get_document_info`：采集当前选中页签的文档信息，',
      '  三个参数：`includeOutline`（元素结构大纲，`<深度> <选择器> [文本]` 逐行）、',
      '  `includeText`（正文纯文本）、`includeNonTextElements`（默认 false，排除 svg/图片等非文本子树）。',
      '',
      '## 推荐工作流',
      '1. 先调 `chrome_extension_get_document_info`（只开 includeOutline）了解页面结构，成本低；',
      '2. 根据大纲定位目标元素对应的页面工具，再调用页面工具执行操作；',
      '3. 操作后再次采集大纲或正文验证结果，确认真实生效后再向用户汇报。',
      '',
      '## 注意事项',
      '- 工具结果均为真实页面返回，禁止编造；失败时阅读错误文本判断（页面未就绪 / 工具不存在 / 超时）。',
      '- 数据源页签由「数据源设置」决定；目标页签刷新后如遇断连，重试即可（自动重建）。',
    ].join('\n'),
  },
];

/** chrome.storage.local 中技能覆写的持久化键（值形态：Record<skillId, SkillDefinition>）。 */
export const SKILL_OVERRIDES_STORAGE_KEY = 'agentSkillOverrides';

/** 按 id 查内置技能摘要（L1 清单数据源；同步、无 IO）。 */
export function getBuiltinSkillSummary(id: string): SkillSummary | null {
  const found = BUILTIN_SKILLS.find((skill) => skill.id === id);
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    description: found.description,
    // exactOptionalPropertyTypes：keywords 仅在存在时携带
    ...(found.keywords !== undefined ? { keywords: found.keywords } : {}),
  };
}

/** 宽松校验存储中的覆写条目（最小形状：id/name/description/content 均非空字符串且 id 与请求一致）。 */
function asValidOverride(id: string, value: unknown): SkillDefinition | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record['id'] !== id) return null;
  if (typeof record['name'] !== 'string' || record['name'].length === 0) return null;
  if (typeof record['description'] !== 'string' || record['description'].length === 0) return null;
  if (typeof record['content'] !== 'string' || record['content'].length === 0) return null;
  return {
    id: record['id'],
    name: record['name'],
    description: record['description'],
    content: record['content'],
  };
}

/** 宿主技能源（core SkillResolverDeps 的实现：assets 内置清单 + storage 覆写）。 */
export interface HostSkillSource {
  loadOverride(id: string): Promise<SkillDefinition | null>;
  loadAsset(id: string): Promise<SkillDefinition | null>;
}

export function createHostSkillSource(
  storage: ProfileStorageLike = chrome.storage.local as unknown as ProfileStorageLike
): HostSkillSource {
  return {
    async loadOverride(id) {
      const stored = await storage.get([SKILL_OVERRIDES_STORAGE_KEY]);
      const map = stored[SKILL_OVERRIDES_STORAGE_KEY];
      if (typeof map !== 'object' || map === null) return null;
      return asValidOverride(id, (map as Record<string, unknown>)[id]);
    },
    async loadAsset(id) {
      return BUILTIN_SKILLS.find((skill) => skill.id === id) ?? null;
    },
  };
}
