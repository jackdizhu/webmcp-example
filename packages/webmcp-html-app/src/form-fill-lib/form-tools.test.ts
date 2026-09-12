// form-tools 单测：fill / submit / get_schema / get_values / query_table_data，控制器用 stub 替换。
import { describe, it, expect } from 'vitest';
import { createFormFillTools } from './form-tools';
import type { FormTool } from './form-tools';
import type {
  FieldSchema,
  FormControllerLike,
  SchemaViewField,
  SubmitOutcome,
  FillOutcome,
  ToolTextResult,
  TableControllerLike,
} from './types';
import { findMissingRequired } from './validation';

const opts = [
  { value: 'WH-01', label: '上海' },
  { value: 'WH-02', label: '北京' },
];

const schema: FieldSchema[] = [
  { name: 'customer', label: '客户', type: 'text', required: true },
  { name: 'warehouse', label: '仓库', type: 'select', required: true, options: opts },
  { name: 'quantity', label: '数量', type: 'number', required: true },
  { name: 'available_stock', label: '库存', type: 'select', required: false, options: opts, readOnly: true },
];

function makeController(onSubmit?: (v: Record<string, unknown>) => Promise<SubmitOutcome>) {
  const store: Record<string, unknown> = {};
  const controller: FormControllerLike = {
    getSchema: () => ({ id: 'order', title: '订单', fields: schema }),
    getSchemaView: async (): Promise<SchemaViewField[]> =>
      schema.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        options: f.options ?? [],
        dataSource: f.dataSource,
        freshRequired: f.freshRequired,
        readOnly: f.readOnly,
        freshnessSec: f.dataSource ? 10 : null,
      })),
    getValues: () => ({ ...store }),
    applyValues: async (v) => {
      Object.assign(store, v);
    },
    validateRequired: () => findMissingRequired(schema, store),
    requestSubmit: async () => {
      const missing = findMissingRequired(schema, store);
      if (missing.length > 0) {
        return { success: false, errorType: 'VALIDATION', reason: '缺少必填字段: ' + missing.join(', ') };
      }
      return onSubmit ? onSubmit(store) : { success: true, data: store };
    },
  };
  return { controller, store };
}

function parseAs<T>(t: ToolTextResult): T {
  return JSON.parse(t.content[0].text) as T;
}

function build(onSubmit?: (v: Record<string, unknown>) => Promise<SubmitOutcome>) {
  const { controller } = makeController(onSubmit);
  const arr = createFormFillTools({ controller });
  return Object.fromEntries(arr.map((t) => [t.name, t])) as Record<string, FormTool>;
}

describe('createFormFillTools', () => {
  it('form_get_schema 返回字段与选项', async () => {
    const t = build();
    const out = parseAs<{ formId: string; fields: SchemaViewField[] }>(await t['form_get_schema'].execute({}));
    expect(out.formId).toBe('order');
    const wh = out.fields.find((f) => f.name === 'warehouse')!;
    expect(wh.options.length).toBe(2);
  });

  it('form_fill_fields 未知字段 -> UNKNOWN_FIELD', async () => {
    const t = build();
    const out = parseAs<FillOutcome>(await t['form_fill_fields'].execute({ values: { nope: 1 } }));
    expect(out.success).toBe(false);
    expect(out.issues[0].errorType).toBe('UNKNOWN_FIELD');
  });

  it('form_fill_fields 非法选项 -> INVALID_OPTION + llmHint', async () => {
    const t = build();
    const out = parseAs<FillOutcome>(await t['form_fill_fields'].execute({ values: { warehouse: 'BAD' } }));
    expect(out.success).toBe(false);
    expect(out.issues[0].errorType).toBe('INVALID_OPTION');
    expect(out.issues[0].llmHint).toContain('上海');
  });

  it('form_fill_fields label 归一化并成功填充', async () => {
    const t = build();
    const out = parseAs<FillOutcome>(await t['form_fill_fields'].execute({ values: { warehouse: '北京' } }));
    expect(out.success).toBe(true);
    expect(out.filled).toEqual(['warehouse']);
    const vals = parseAs<{ success: boolean; values: Record<string, unknown> }>(await t['form_get_values'].execute({}));
    expect(vals.values['warehouse']).toBe('WH-02');
  });

  it('form_fill_fields 只读字段 -> READONLY', async () => {
    const t = build();
    const out = parseAs<FillOutcome>(await t['form_fill_fields'].execute({ values: { available_stock: 'WH-01' } }));
    expect(out.issues[0].errorType).toBe('READONLY');
  });

  it('form_submit 必填缺失 -> VALIDATION', async () => {
    const t = build();
    const out = parseAs<SubmitOutcome>(await t['form_submit'].execute({}));
    expect(out.success).toBe(false);
    expect(out.errorType).toBe('VALIDATION');
  });

  it('form_submit 成功透传 data', async () => {
    const t = build();
    await t['form_fill_fields'].execute({ values: { customer: '甲', warehouse: 'WH-01', quantity: 3 } });
    const out = parseAs<SubmitOutcome>(await t['form_submit'].execute({}));
    expect(out.success).toBe(true);
    expect(out.data).toBeDefined();
  });

  it('form_submit 库存不足 -> STOCK_CHANGED + latestData', async () => {
    const t = build(async () => ({
      success: false,
      errorType: 'STOCK_CHANGED',
      reason: '当前可用库存 8，不足 20',
      latestData: [{ value: '8', label: '可用库存 8' }],
      llmHint: '基于 latestData 重新决策后重试',
    }));
    await t['form_fill_fields'].execute({ values: { customer: '甲', warehouse: 'WH-01', quantity: 20 } });
    const out = parseAs<SubmitOutcome>(await t['form_submit'].execute({}));
    expect(out.success).toBe(false);
    expect(out.errorType).toBe('STOCK_CHANGED');
    expect(out.latestData).toBeDefined();
  });

  it('query_table_data 未配置时返回失败', async () => {
    const t = build();
    const out = parseAs<{ success: boolean; reason?: string }>(await t['query_table_data'].execute({}));
    expect(out.success).toBe(false);
  });

  it('query_table_data 渲染并返行数据', async () => {
    const renderCalls: unknown[] = [];
    const table: TableControllerLike = { render: (c, r, f) => renderCalls.push({ c, r, f }) };
    const arr = createFormFillTools({
      controller: makeController().controller,
      table,
      queryData: async () => ({ columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }], total: 1 }),
    });
    const t = Object.fromEntries(arr.map((x) => [x.name, x])) as Record<string, FormTool>;
    const out = parseAs<{ success: boolean; total: number; rows: unknown[] }>(await t['query_table_data'].execute({}));
    expect(out.success).toBe(true);
    expect(out.total).toBe(1);
    expect(renderCalls.length).toBe(1);
  });

  it('query_table_data 透传 filter 到 queryData 并回传 hint', async () => {
    const received: unknown[] = [];
    const table: TableControllerLike = { render: () => {} };
    const arr = createFormFillTools({
      controller: makeController().controller,
      table,
      queryData: async (filter) => {
        received.push(filter);
        const hit = filter.salesperson === 'S-01';
        return {
          columns: [{ key: 'a', label: 'A' }],
          rows: hit ? [{ a: 1 }] : [],
          total: hit ? 1 : 0,
          ...(hit ? {} : { hint: '未找到该销售员的订单' }),
        };
      },
    });
    const t = Object.fromEntries(arr.map((x) => [x.name, x])) as Record<string, FormTool>;

    const hit = parseAs<{ success: boolean; total: number; rows: unknown[]; hint?: string }>(
      await t['query_table_data'].execute({ filter: { salesperson: 'S-01' } }),
    );
    expect(hit.success).toBe(true);
    expect(hit.total).toBe(1);
    expect(hit.hint).toBeUndefined();
    expect(received[0]).toEqual({ salesperson: 'S-01' });

    const miss = parseAs<{ success: boolean; total: number; hint?: string }>(
      await t['query_table_data'].execute({ filter: { salesperson: 'S-99' } }),
    );
    expect(miss.total).toBe(0);
    expect(miss.hint).toBe('未找到该销售员的订单');

    // 不传 filter → 空对象透传
    await t['query_table_data'].execute({});
    expect(received[2]).toEqual({});
  });
});
