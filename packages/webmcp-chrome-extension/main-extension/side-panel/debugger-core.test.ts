// debugger-core 纯逻辑单测：JSON 校验、结果格式化、历史裁剪、消息组装。
import { describe, expect, it } from 'vitest';
import {
  appendRun,
  composeHandoffMessage,
  DEBUG_HISTORY_LIMIT,
  formatRawJson,
  validateArgsText,
  type DebugRun,
} from './debugger-core';

const makeRun = (overrides: Partial<DebugRun> = {}): DebugRun => ({
  name: 'get_status',
  args: { id: 1 },
  argsText: '{"id": 1}',
  failed: false,
  resultText: 'ok',
  elapsedMs: 12,
  ...overrides,
});

describe('validateArgsText', () => {
  it('空文本视为空对象', () => {
    expect(validateArgsText('')).toEqual({ ok: true, value: {} });
    expect(validateArgsText('   \n  ')).toEqual({ ok: true, value: {} });
  });

  it('合法对象通过并解析', () => {
    const check = validateArgsText('{"id": 1, "name": "x"}');
    expect(check).toEqual({ ok: true, value: { id: 1, name: 'x' } });
  });

  it('数组与标量被拒绝', () => {
    expect(validateArgsText('[1,2]')).toMatchObject({ ok: false });
    expect(validateArgsText('42')).toMatchObject({ ok: false });
    expect(validateArgsText('"str"')).toMatchObject({ ok: false });
    expect(validateArgsText('null')).toMatchObject({ ok: false });
  });

  it('语法错误返回错误信息', () => {
    const check = validateArgsText('{bad json');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain('JSON 语法错误');
  });
});

describe('formatRawJson', () => {
  it('两空格缩进序列化', () => {
    expect(formatRawJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('循环引用不抛异常而是回退 String()', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => formatRawJson(circular)).not.toThrow();
  });
});

describe('appendRun', () => {
  it('最新记录排最前', () => {
    const first = makeRun({ name: 'a' });
    const second = makeRun({ name: 'b' });
    const history = appendRun([first], second);
    expect(history[0]?.name).toBe('b');
    expect(history[1]?.name).toBe('a');
  });

  it('超过上限丢弃最旧记录', () => {
    let history: DebugRun[] = [];
    for (let i = 0; i < DEBUG_HISTORY_LIMIT + 5; i += 1) {
      history = appendRun(history, makeRun({ name: `tool-${i}` }));
    }
    expect(history).toHaveLength(DEBUG_HISTORY_LIMIT);
    expect(history[0]?.name).toBe(`tool-${DEBUG_HISTORY_LIMIT + 4}`);
    expect(history.at(-1)?.name).toBe('tool-5');
  });
});

describe('composeHandoffMessage', () => {
  it('包含工具名、参数、状态、耗时与结果', () => {
    const message = composeHandoffMessage(
      makeRun({ rawJson: '{"status": "ok"}', elapsedMs: 88 })
    );
    expect(message).toContain('get_status');
    expect(message).toContain('{"id": 1}');
    expect(message).toContain('成功');
    expect(message).toContain('88ms');
    expect(message).toContain('{"status": "ok"}');
  });

  it('失败记录标注失败且优先展示 resultText', () => {
    const message = composeHandoffMessage(
      makeRun({ failed: true, resultText: 'boom' })
    );
    expect(message).toContain('失败');
    expect(message).toContain('boom');
  });

  it('空参数展示为 {}', () => {
    const message = composeHandoffMessage(makeRun({ argsText: '' }));
    expect(message).toContain('- 参数：{}');
  });
});
