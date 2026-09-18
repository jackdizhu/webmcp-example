// 对话视图共享类型（App 与 components/ 下各组件共用）。

/** 单条工具执行的展示痕迹。 */
export interface ToolTraceItem {
  name: string;
  result: string;
  failed: boolean;
  /**
   * 展示类别：'skill' = 技能加载（__agent_load_skill 工具）；'a2a' = A2A 远程智能体调用
   * （a2a__<id>__send_task 工具，徽标 A2A、名称展示远端智能体 id）；缺省 = 普通工具调用。
   */
  kind?: 'tool' | 'skill' | 'a2a';
  /**
   * 展示名（缺省用 name）。SKILL 行展示**技能 id**（如 page-tools-guide）而非工具名 ——
   * 工具名是加载器（__agent_load_skill），技能 id 才是 SKILL 的唯一标识。
   * A2A 行同理展示远端智能体 id（从工具名 a2a__<id>__send_task 提取）。
   */
  label?: string;
}

/** 聊天列表里的一条消息（用户或助手；工具执行作为助手消息的附带痕迹展示）。 */
export interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  toolTrace: ToolTraceItem[];
  /**
   * 瞬态提示（2026-09-18 修复：会话恢复/新建/切换/保存设置等 UI 反馈）。
   * 仅本次 UI 展示 —— 归档快照时被 persistableMessages 过滤，绝不持久化。
   * 否则「恢复会话 A → 切到 B（A 被归档）→ 切回 A → 再追加一条提示」循环累积，
   * 且提示随快照永久固化、多次切换后不断增长。旧快照无此字段（undefined → falsy）天然兼容。
   */
  ephemeral?: boolean;
}

/** 工具执行占位文案，完成后按 name 匹配回填。 */
export const TOOL_PENDING_TEXT = '执行中…';
