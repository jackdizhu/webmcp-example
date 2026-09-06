// 把表单/表格能力桥接为 5 个 WebMCP 工具：form_get_schema / form_fill_fields /
// form_get_values / form_submit / query_table_data。
// 工具编排「读 schema → 校验 → 填充 → 执行时复核」闭环，错误即数据接口（铁律 2/3）。
// 仅依赖 FormControllerLike 接口，便于单测用 stub 替换真实 DOM 控制器。

import type { InputSchema } from '@mcp-b/webmcp-types';
import type {
  FillIssue,
  FillOutcome,
  FormSchema,
  FormToolDeps,
  SchemaViewField,
  SubmitOutcome,
  ToolTextResult,
} from './types';
import { validateFieldValue } from './validation';

/** 与既有 get_status 工具结构对齐；inputSchema 必填，registerTool 可直接接收。 */
export interface FormTool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  execute: (input: Record<string, unknown>) => Promise<ToolTextResult>;
}

function textResult(payload: unknown): ToolTextResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function createFormFillTools(deps: FormToolDeps): FormTool[] {
  const { controller, table, queryData } = deps;

  const getSchemaTool: FormTool = {
    name: 'form_get_schema',
    description:
      '获取页面表单的字段定义、类型、必填项与当前可选选项（含数据获取时间 freshnessSec）。调用其他表单工具前先获取它。',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const view: SchemaViewField[] = await controller.getSchemaView();
      const schema: FormSchema = controller.getSchema();
      return textResult({ formId: schema.id, title: schema.title, fields: view });
    },
  };

  const fillTool: FormTool = {
    name: 'form_fill_fields',
    description:
      '批量填充表单字段。select/radio 字段值非法时返回合法选项列表（含数据新鲜度），AI 可据此一次修正；传 label 会自动归一化为 value。',
    inputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'object',
          description: '字段名→值映射，字段定义先经 form_get_schema 获取',
        },
      },
      required: ['values'],
    },
    execute: async (input) => {
      const values = (input.values ?? {}) as Record<string, unknown>;
      const schema = controller.getSchema();
      const view = await controller.getSchemaView();
      const viewByName = new Map(view.map((v) => [v.name, v]));
      const known = new Set(schema.fields.map((f) => f.name));

      const issues: FillIssue[] = [];
      const normalized: Record<string, unknown> = {};
      const filled: string[] = [];

      for (const [name, raw] of Object.entries(values)) {
        if (!known.has(name)) {
          issues.push({
            field: name,
            errorType: 'UNKNOWN_FIELD',
            reason: `未知字段: ${name}`,
            llmHint: `可用字段: ${[...known].join(', ')}`,
          });
          continue;
        }
        const fv = viewByName.get(name)!;
        if (fv.readOnly) {
          issues.push({
            field: name,
            errorType: 'READONLY',
            reason: `字段「${fv.label}」为只读展示，不可由 AI 填充`,
            llmHint: '请填写其他可编辑字段',
          });
          continue;
        }
        const field = schema.fields.find((f) => f.name === name)!;
        const r = validateFieldValue({
          field,
          rawValue: raw,
          options: fv.options,
          freshnessSec: fv.freshnessSec,
        });
        if (!r.ok && r.issue) {
          issues.push(r.issue);
          continue;
        }
        normalized[name] = r.normalizedValue;
        filled.push(name);
      }

      await controller.applyValues(normalized, filled);
      const outcome: FillOutcome = { success: issues.length === 0, filled, issues };
      return textResult(outcome);
    },
  };

  const getValuesTool: FormTool = {
    name: 'form_get_values',
    description: '读取当前表单值，供 AI 确认填充结果',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => textResult({ success: true, values: controller.getValues() }),
  };

  const submitTool: FormTool = {
    name: 'form_submit',
    description:
      '提交表单。提交前做必填校验；动态/强时效字段由 onSubmit 处理器执行 forceFresh 复核（如库存不足返回 STOCK_CHANGED + latestData）。',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const outcome: SubmitOutcome = await controller.requestSubmit();
      return textResult(outcome);
    },
  };

  const tableTool: FormTool = {
    name: 'query_table_data',
    description: '查询订单数据，渲染到页面结果表格并返回结构化行数据（含数据获取时间）',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      if (!queryData || !table) {
        return textResult({ success: false, reason: '查询结果表格未配置' });
      }
      const res = await queryData();
      const fetchedAt = Date.now();
      table.render(res.columns, res.rows, fetchedAt);
      return textResult({ success: true, total: res.total, fetchedAt, rows: res.rows });
    },
  };

  return [getSchemaTool, fillTool, getValuesTool, submitTool, tableTool];
}
