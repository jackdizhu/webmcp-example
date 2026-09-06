// validation 单测：选项校验 / label→value 归一化 / 数字 / 必填 / llmHint 截断与新鲜度标注。
import { describe, it, expect } from 'vitest';
import { validateFieldValue, findMissingRequired, optionListHint } from './validation';
import type { FieldSchema } from './types';

const opts = [
  { value: 'WH-01', label: '上海' },
  { value: 'WH-02', label: '北京' },
  { value: 'WH-03', label: '广州' },
];

const sel: FieldSchema = { name: 'wh', label: '仓库', type: 'select', required: true, options: opts };

describe('validateFieldValue', () => {
  it('select value 直匹配', () => {
    const r = validateFieldValue({ field: sel, rawValue: 'WH-02', options: opts });
    expect(r.ok).toBe(true);
    expect(r.normalizedValue).toBe('WH-02');
  });

  it('select label 归一化为 value', () => {
    const r = validateFieldValue({ field: sel, rawValue: '北京', options: opts });
    expect(r.ok).toBe(true);
    expect(r.normalizedValue).toBe('WH-02');
  });

  it('select 非法值 -> INVALID_OPTION + llmHint（含新鲜度）', () => {
    const r = validateFieldValue({ field: sel, rawValue: 'ZZZ', options: opts, freshnessSec: 30 });
    expect(r.ok).toBe(false);
    expect(r.issue?.errorType).toBe('INVALID_OPTION');
    expect(r.issue?.llmHint).toContain('上海');
    expect(r.issue?.llmHint).toContain('（数据获取于 30 秒前）');
  });

  it('select 非法值 llmHint 截断 15 个', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ value: 'V' + i, label: 'L' + i }));
    const r = validateFieldValue({ field: { ...sel, options: big }, rawValue: 'BAD', options: big });
    const listed = r.issue!.llmHint!.match(/V\d+/g)!;
    expect(listed.length).toBe(15);
  });

  it('number 非法 -> INVALID_VALUE', () => {
    const num: FieldSchema = { name: 'qty', label: '数量', type: 'number', required: true };
    const r = validateFieldValue({ field: num, rawValue: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.issue?.errorType).toBe('INVALID_VALUE');
  });

  it('number 合法 -> number', () => {
    const num: FieldSchema = { name: 'qty', label: '数量', type: 'number', required: true };
    const r = validateFieldValue({ field: num, rawValue: '12' });
    expect(r.ok).toBe(true);
    expect(r.normalizedValue).toBe(12);
  });

  it('checkbox 归一化', () => {
    const cb: FieldSchema = { name: 'u', label: '加急', type: 'checkbox', required: false };
    expect(validateFieldValue({ field: cb, rawValue: 'true' }).normalizedValue).toBe(true);
    expect(validateFieldValue({ field: cb, rawValue: true }).normalizedValue).toBe(true);
    expect(validateFieldValue({ field: cb, rawValue: '0' }).normalizedValue).toBe(false);
  });
});

describe('findMissingRequired', () => {
  it('找出缺失必填', () => {
    const fields: FieldSchema[] = [
      { name: 'a', label: 'A', type: 'text', required: true },
      { name: 'b', label: 'B', type: 'text', required: false },
      { name: 'c', label: 'C', type: 'text', required: true },
    ];
    expect(findMissingRequired(fields, { a: 'x', c: '' })).toEqual(['c']);
  });
});

describe('optionListHint', () => {
  it('截断 15', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ value: 'V' + i, label: 'L' + i }));
    expect(optionListHint(big).match(/V\d+/g)!.length).toBe(15);
  });
});
