// 调试 Tab 的纯逻辑（与 Vue 组件解耦，便于单测）：
// 参数 JSON 校验、inputSchema 参数说明与模板生成、执行结果格式化、历史记录裁剪、
// 「发送到对话」消息组装。

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

// ---- inputSchema → 参数说明 / 参数模板（调试页「参数说明」面板）----

/** 单个入参的说明条目（按声明顺序）。 */
export interface ToolParameterDescriptor {
  /** 参数名。 */
  name: string;
  /** 归一化类型标签（如 string / boolean / array&lt;string&gt; / string | null / any）。 */
  type: string;
  /** 是否在 schema.required 中声明。 */
  required: boolean;
  /** 参数说明（schema 未提供时为空串）。 */
  description: string;
  /** 枚举取值（JSON Schema enum 的字符串化结果；无则空数组）。 */
  enumValues: string[];
  /** 是否声明了默认值（有默认值时模板直接采用）。 */
  hasDefault: boolean;
  /** 声明的默认值（hasDefault 为 false 时无意义）。 */
  defaultValue: unknown;
}

/** 判定未知值是否为普通对象（schema 节点）。 */
function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 归一化 JSON Schema type 为展示标签：多类型用 " | " 连接，数组递归标注元素类型。 */
function normalizeSchemaType(prop: Record<string, unknown>): string {
  const raw = prop['type'];
  const types = (Array.isArray(raw) ? raw : [raw]).filter(
    (item): item is string => typeof item === 'string' && item.length > 0
  );
  if (types.length === 0) return 'any';
  return types
    .map((type) => {
      if (type !== 'array') return type;
      const items = prop['items'];
      return `array<${isSchemaRecord(items) ? normalizeSchemaType(items) : 'any'}>`;
    })
    .join(' | ');
}

/** 枚举取值字符串化（对象/数组等非字符串值回退 JSON）。 */
function normalizeSchemaEnum(prop: Record<string, unknown>): string[] {
  const values = prop['enum'];
  if (!Array.isArray(values)) return [];
  return values.map((value) =>
    typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  );
}

/**
 * 解析 inputSchema 的 properties 为参数说明列表（按声明顺序）。
 * schema 非对象 / 无 properties 时返回空数组（表示该工具无需参数）。
 */
export function describeInputSchema(schema: unknown): ToolParameterDescriptor[] {
  if (!isSchemaRecord(schema)) return [];
  const properties = schema['properties'];
  if (!isSchemaRecord(properties)) return [];
  const rawRequired = schema['required'];
  const requiredNames = new Set(
    (Array.isArray(rawRequired) ? rawRequired : []).filter(
      (name): name is string => typeof name === 'string'
    )
  );
  return Object.entries(properties).map(([name, value]) => {
    const prop = isSchemaRecord(value) ? value : {};
    return {
      name,
      type: normalizeSchemaType(prop),
      required: requiredNames.has(name),
      description: typeof prop['description'] === 'string' ? prop['description'] : '',
      enumValues: normalizeSchemaEnum(prop),
      hasDefault: Object.prototype.hasOwnProperty.call(prop, 'default'),
      defaultValue: prop['default'],
    };
  });
}

/** 单个参数的模板占位值：优先默认值，否则按类型给最小合法值。 */
function schemaPlaceholder(prop: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(prop, 'default')) return prop['default'];
  const type = normalizeSchemaType(prop);
  if (type.startsWith('array<')) return [];
  if (type === 'object') return {};
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'number') return 0;
  return '';
}

/**
 * 依据 inputSchema 生成参数模板（含全部声明属性，取默认值或类型占位值），
 * 供调试页「填入参数模板」一键构造合法参数骨架。
 */
export function buildArgsTemplate(schema: unknown): Record<string, unknown> {
  if (!isSchemaRecord(schema)) return {};
  const properties = schema['properties'];
  if (!isSchemaRecord(properties)) return {};
  const template: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    template[name] = schemaPlaceholder(isSchemaRecord(value) ? value : {});
  }
  return template;
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
