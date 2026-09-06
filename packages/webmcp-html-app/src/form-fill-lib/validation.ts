// 表单字段校验（纯函数，零 DOM 依赖，全量单测覆盖）。
// 核心策略（对齐 docs/webmcp-form-fill.md）：
//   铁律 2「校验失败的错误信息就是最好的数据接口」——select 非法值时把新鲜合法选项直接喂给 AI。

import type {
  DataSourceOption,
  FieldSchema,
  FillIssue,
} from './types';

export interface FieldValidationResult {
  ok: boolean;
  normalizedValue?: string | number | boolean;
  issue?: FillIssue;
}

/** llmHint 中展示的合法选项最大条数（避免上下文爆炸）。 */
export const OPTION_HINT_MAX = 15;

/** 将选项列表格式化为喂给 AI 的紧凑提示串：`value(label), ...`。 */
export function optionListHint(options: DataSourceOption[], max: number = OPTION_HINT_MAX): string {
  return options
    .slice(0, max)
    .map((o) => `${o.value}(${o.label})`)
    .join(', ');
}

/**
 * select/radio 选项校验：支持 value 直匹配与 label→value 归一化。
 * 非法时返回 INVALID_OPTION 并附 llmHint（含新鲜度标注），供 AI 一次修正。
 */
export function normalizeOptionValue(
  fieldName: string,
  fieldLabel: string,
  rawValue: unknown,
  options: DataSourceOption[] | undefined,
  freshnessSec: number | null,
): FieldValidationResult {
  // 无选项配置（如纯静态字段）按原值接受
  if (!options || options.length === 0) {
    return { ok: true, normalizedValue: rawValue == null ? '' : String(rawValue) };
  }
  const str = rawValue == null ? '' : String(rawValue);
  const byValue = options.find((o) => o.value === str);
  if (byValue) return { ok: true, normalizedValue: str };
  const byLabel = options.find((o) => o.label === str);
  if (byLabel) return { ok: true, normalizedValue: byLabel.value };

  const hint = optionListHint(options);
  const freshNote = freshnessSec == null ? '' : `（数据获取于 ${freshnessSec} 秒前）`;
  return {
    ok: false,
    issue: {
      field: fieldName,
      errorType: 'INVALID_OPTION',
      reason: `字段「${fieldLabel}」收到非法选项值: ${str}`,
      llmHint: `合法选项(截断${OPTION_HINT_MAX}): ${hint}${freshNote}`,
    },
  };
}

/** 单字段校验（按类型分派）。 */
export function validateFieldValue(input: {
  field: FieldSchema;
  rawValue: unknown;
  options?: DataSourceOption[];
  freshnessSec?: number | null;
}): FieldValidationResult {
  const { field, rawValue, options, freshnessSec } = input;
  switch (field.type) {
    case 'select':
    case 'radio':
      return normalizeOptionValue(field.name, field.label, rawValue, options, freshnessSec ?? null);
    case 'number': {
      if (rawValue === '' || rawValue === null || rawValue === undefined) {
        return { ok: true, normalizedValue: '' };
      }
      const n = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      if (Number.isNaN(n)) {
        return {
          ok: false,
          issue: {
            field: field.name,
            errorType: 'INVALID_VALUE',
            reason: `字段「${field.label}」需为数字，收到: ${String(rawValue)}`,
          },
        };
      }
      return { ok: true, normalizedValue: n };
    }
    case 'checkbox': {
      const b = rawValue === true || rawValue === 'true' || rawValue === '1' || rawValue === 1;
      return { ok: true, normalizedValue: b };
    }
    default:
      return { ok: true, normalizedValue: rawValue == null ? '' : String(rawValue) };
  }
}

/** 找出缺失的必填字段名。 */
export function findMissingRequired(fields: FieldSchema[], values: Record<string, unknown>): string[] {
  return fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = values[f.name];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.name);
}
