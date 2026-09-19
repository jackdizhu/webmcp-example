// logger-core 纯函数单测：轮转数量计算 + 内容截断（正常 + 边界 + 异常场景）。
import { describe, expect, it } from 'vitest';
import { MAX_CONTENT_LENGTH, MAX_LOG_RECORDS, ROTATE_MARGIN, computeRotateCount, truncateContent } from './logger-core';

describe('computeRotateCount', () => {
  it('未达上限返回 0（不足不删）', () => {
    expect(computeRotateCount(0)).toBe(0);
    expect(computeRotateCount(1)).toBe(0);
    expect(computeRotateCount(MAX_LOG_RECORDS - 1)).toBe(0);
  });

  it('恰达上限 200 删 10（上限 + 余量）', () => {
    expect(computeRotateCount(MAX_LOG_RECORDS)).toBe(ROTATE_MARGIN);
    expect(computeRotateCount(200)).toBe(10);
  });

  it('超限按 (总数 - 200) + 10 删除', () => {
    expect(computeRotateCount(205)).toBe(15);
    expect(computeRotateCount(220)).toBe(30);
  });

  it('非法输入（非整数 / 负数）返回 0', () => {
    expect(computeRotateCount(-5)).toBe(0);
    expect(computeRotateCount(1.5)).toBe(0);
    expect(computeRotateCount(Number.NaN)).toBe(0);
  });
});

describe('truncateContent', () => {
  it('不超上限原样返回', () => {
    expect(truncateContent('你好', 10)).toBe('你好');
    expect(truncateContent('abc', 3)).toBe('abc');
  });

  it('超上限保留前 max 字符并追加截断标记', () => {
    expect(truncateContent('abcdef', 3)).toBe('abc…[截断，原文 6 字符]');
  });

  it('缺省上限为 8000 字符', () => {
    expect(truncateContent('a'.repeat(MAX_CONTENT_LENGTH))).toHaveLength(MAX_CONTENT_LENGTH);
    expect(truncateContent('a'.repeat(MAX_CONTENT_LENGTH + 1))).toBe(
      `${'a'.repeat(MAX_CONTENT_LENGTH)}…[截断，原文 ${MAX_CONTENT_LENGTH + 1} 字符]`
    );
  });
});
