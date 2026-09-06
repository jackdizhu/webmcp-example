// 对话视图共享类型（App 与 components/ 下各组件共用）。

/** 单条工具执行的展示痕迹。 */
export interface ToolTraceItem {
  name: string;
  result: string;
  failed: boolean;
}

/** 聊天列表里的一条消息（用户或助手；工具执行作为助手消息的附带痕迹展示）。 */
export interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  toolTrace: ToolTraceItem[];
}

/** 工具执行占位文案，完成后按 name 匹配回填。 */
export const TOOL_PENDING_TEXT = '执行中…';
