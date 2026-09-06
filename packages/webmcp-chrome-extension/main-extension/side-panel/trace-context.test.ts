// trace-context 纯逻辑单测：traceId 生成与当前轮上下文切换。
import { describe, expect, it } from 'vitest';
import {
  clearCurrentTrace,
  generateTraceId,
  getCurrentTrace,
  setCurrentTrace,
} from './trace-context';

describe('generateTraceId', () => {
  it('格式为 trace_<时间戳base36>_<6位随机>', () => {
    const id = generateTraceId(1700000000000, () => 0.5);
    const [, ts36, rand] = id.split('_');
    expect(id.startsWith('trace_')).toBe(true);
    expect(ts36).toBe((1700000000000).toString(36));
    expect(rand).toHaveLength(6);
    expect(rand).toMatch(/^[a-z0-9]{6}$/);
  });

  it('随机源注入后可复现', () => {
    const fixed = (): number => 0;
    expect(generateTraceId(123, fixed)).toBe(`trace_${(123).toString(36)}_aaaaaa`);
  });

  it('两次生成结果不同（默认随机源）', () => {
    expect(generateTraceId(1700000000000)).not.toBe(generateTraceId(1700000000000));
  });
});

describe('当前轮上下文', () => {
  it('初始无 trace', () => {
    expect(getCurrentTrace()).toBeNull();
  });

  it('设置后可读取，清除后归空', () => {
    setCurrentTrace('trace_abc_def');
    expect(getCurrentTrace()).toBe('trace_abc_def');
    clearCurrentTrace();
    expect(getCurrentTrace()).toBeNull();
  });

  it('重复设置覆盖（轮次串行前提）', () => {
    setCurrentTrace('trace_1_a');
    setCurrentTrace('trace_2_b');
    expect(getCurrentTrace()).toBe('trace_2_b');
    clearCurrentTrace();
  });
});
