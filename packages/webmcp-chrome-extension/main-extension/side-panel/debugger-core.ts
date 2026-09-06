// 调试 Tab 的纯逻辑（与 Vue 组件解耦，便于单测）：
// 参数 JSON 校验、执行结果格式化、历史记录裁剪、「发送到对话」消息组装。

/** 一次手动工具执行的完整记录。 */
export interface DebugRun {
  /** 工具名。 */
  name: string;
  /** 实际传入的参数（JSON 解析后的对象；空参数为 {}）。 */
  args: Record<string, unknown>;
  /** 参数原始 JSON 文本（回填编辑器用）。 */
  argsText: string;
  /** 执行是否失败（isError 或抛异常）。 */
  failed: boolean;
  /** 结果文本（serializeToolResult 产物或错误信息）。 */
  resultText: string;
  /** 原始结果 JSON（仅在成功且有结果时携带）。 */
  rawJson?: string;
  /** 耗时（毫秒）。 */
  elapsedMs: number;
}

/** 参数 JSON 校验结果。 */
export type ArgsValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** 校验参数编辑器文本：必须为合法 JSON 且解析为对象（数组/标量均不接受）。 */
export function validateArgsText(text: string): ArgsValidation {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '参数必须是 JSON 对象（{...}），不接受数组或标量' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** 格式化原始结果 JSON；序列化失败时回退 String()。 */
export function formatRawJson(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2) ?? 'null';
  } catch {
    return String(result);
  }
}

/** 调试历史最大保留条数（超出后丢弃最旧记录）。 */
export const DEBUG_HISTORY_LIMIT = 20;

/** 追加一条执行记录到历史（最新在前，裁剪到上限）。 */
export function appendRun(history: readonly DebugRun[], run: DebugRun): DebugRun[] {
  return [run, ...history].slice(0, DEBUG_HISTORY_LIMIT);
}

/**
 * 组装「发送到对话」的预设消息：把工具名、参数、执行结果结构化后交给 agent 继续分析。
 * 注意：该消息走正常 agent 循环（消耗 token），由用户主动触发。
 */
export function composeHandoffMessage(run: DebugRun): string {
  const lines = [
    `我刚在调试模式手动执行了工具 ${run.name}，请基于以下执行结果继续分析：`,
    `- 工具：${run.name}`,
    `- 参数：${run.argsText.trim().length > 0 ? run.argsText.trim() : '{}'}`,
    `- 状态：${run.failed ? '失败' : '成功'}`,
    `- 耗时：${run.elapsedMs}ms`,
    `- 结果：`,
    run.rawJson ?? run.resultText,
  ];
  return lines.join('\n');
}
