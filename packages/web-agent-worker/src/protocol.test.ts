// protocol 单测：双向消息校验（合法通过 / 非法拒绝）。
import { describe, expect, it } from 'vitest';
import {
  isWebAgentWorkerErrorCode,
  validateMainToWorkerMessage,
  validateWorkerToMainMessage,
  WebAgentWorkerError,
} from './protocol';

const validConfig = {
  dify: { endpoint: 'https://dify.example.test/v1/chat-messages', apiKey: 'app-x', user: 'u-1' },
  llm: { apiKey: 'k', baseUrl: 'https://llm.example.test', model: 'm' },
};

describe('validateMainToWorkerMessage', () => {
  it('init：合法配置通过；dify 必填字段缺失拒绝', () => {
    const ok = validateMainToWorkerMessage({ kind: 'init', config: validConfig });
    expect(ok).toEqual({ kind: 'init', config: validConfig });
    expect(() =>
      validateMainToWorkerMessage({ kind: 'init', config: { dify: { endpoint: '', apiKey: '', user: '' } } })
    ).toThrow();
  });

  it('chat：format 联合校验；query 必填', () => {
    expect(
      validateMainToWorkerMessage({ kind: 'chat', requestId: 'r1', input: { query: 'q' }, format: 'sse' })
    ).toMatchObject({ kind: 'chat', format: 'sse' });
    expect(() => validateMainToWorkerMessage({ kind: 'chat', requestId: 'r1', input: { query: 'q' }, format: 'xml' })).toThrow();
    expect(() => validateMainToWorkerMessage({ kind: 'chat', requestId: 'r1', input: {}, format: 'json' })).toThrow();
  });

  it('run-agent：tools 缺省为空数组；cancel 省略 requestId 合法', () => {
    const run = validateMainToWorkerMessage({ kind: 'run-agent', requestId: 'r2', input: { message: 'hi' } });
    expect(run).toMatchObject({ kind: 'run-agent', tools: [] });
    expect(validateMainToWorkerMessage({ kind: 'cancel' })).toEqual({ kind: 'cancel' });
    expect(validateMainToWorkerMessage({ kind: 'cancel', requestId: 'r1' })).toEqual({ kind: 'cancel', requestId: 'r1' });
  });

  it('未知 kind 拒绝', () => {
    expect(() => validateMainToWorkerMessage({ kind: 'nope' })).toThrow();
    expect(() => validateMainToWorkerMessage(null)).toThrow();
  });
});

describe('validateWorkerToMainMessage', () => {
  it('ready / chunk / agent-accepted / tool-call 通过', () => {
    expect(validateWorkerToMainMessage({ kind: 'ready' })).toEqual({ kind: 'ready' });
    expect(
      validateWorkerToMainMessage({ kind: 'chunk', requestId: 'r1', event: 'message', delta: 'x', conversationId: 'c' })
    ).toMatchObject({ kind: 'chunk', conversationId: 'c' });
    expect(validateWorkerToMainMessage({ kind: 'agent-accepted', requestId: 'r1' })).toMatchObject({ requestId: 'r1' });
    const toolCall = validateWorkerToMainMessage({ kind: 'tool-call', requestId: 'r1', toolCallId: 't1', name: 'n', args: { a: 1 } });
    expect(toolCall).toMatchObject({ kind: 'tool-call', name: 'n' });
  });

  it('done：chat / agent 双形态；taskKind 非法拒绝', () => {
    expect(
      validateWorkerToMainMessage({ kind: 'done', requestId: 'r1', taskKind: 'chat', answer: 'a', durationMs: 5 })
    ).toMatchObject({ taskKind: 'chat', answer: 'a', durationMs: 5 });
    expect(
      validateWorkerToMainMessage({ kind: 'done', requestId: 'r1', taskKind: 'agent', text: 't', transcript: [] })
    ).toMatchObject({ taskKind: 'agent' });
    expect(() => validateWorkerToMainMessage({ kind: 'done', requestId: 'r1', taskKind: 'x' })).toThrow();
  });

  it('error：code 白名单校验', () => {
    expect(
      validateWorkerToMainMessage({ kind: 'error', requestId: 'r1', code: 'agent-busy', message: 'm' })
    ).toMatchObject({ code: 'agent-busy' });
    expect(() => validateWorkerToMainMessage({ kind: 'error', requestId: 'r1', code: 'nope', message: 'm' })).toThrow();
    expect(isWebAgentWorkerErrorCode('cancelled')).toBe(true);
    expect(isWebAgentWorkerErrorCode('x')).toBe(false);
  });
});

describe('WebAgentWorkerError', () => {
  it('携带 code 与 name', () => {
    const error = new WebAgentWorkerError('timeout', '超时');
    expect(error.code).toBe('timeout');
    expect(error.name).toBe('WebAgentWorkerError');
    expect(error.message).toBe('超时');
  });
});
