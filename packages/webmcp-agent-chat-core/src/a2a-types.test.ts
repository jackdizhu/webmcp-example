// a2a-types 单测：Agent Card 校验与规范化 / task 校验 / 部件文本化 / 状态判定。
import { describe, expect, it } from 'vitest';
import {
  isHttpUrl,
  isTerminalTaskState,
  messageToText,
  partToText,
  validateA2aTask,
  validateAgentCard,
} from './a2a-types';

/** 合法卡片基线（最小必选字段）。 */
const card = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: '文档分析智能体',
  description: '分析上传的文档并回答问题',
  version: '1.0.0',
  supportedInterfaces: [
    { url: 'https://a2a.example.com/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'doc-qa', name: '文档问答', description: '基于文档内容回答问题', tags: ['doc'] }],
  ...overrides,
});

describe('validateAgentCard', () => {
  it('合法卡片通过并原样保留必选字段', () => {
    const validated = validateAgentCard(card());
    expect(validated.name).toBe('文档分析智能体');
    expect(validated.version).toBe('1.0.0');
    expect(validated.skills).toHaveLength(1);
  });

  it('supportedInterfaces 过滤出 JSON-RPC 绑定（大小写不敏感）', () => {
    const validated = validateAgentCard(
      card({
        supportedInterfaces: [
          { url: 'https://grpc.example.com', protocolBinding: 'GRPC' },
          { url: 'https://a2a.example.com/v1', protocolBinding: 'JSONRPC' },
        ],
      })
    );
    expect(validated.supportedInterfaces).toHaveLength(1);
    expect(validated.supportedInterfaces[0]!.url).toBe('https://a2a.example.com/v1');
  });

  it('全部接口都非 JSON-RPC 绑定时抛错', () => {
    expect(() =>
      validateAgentCard(card({ supportedInterfaces: [{ url: 'https://x', protocolBinding: 'GRPC' }] }))
    ).toThrow('JSON-RPC');
  });

  it('缺 JSON-RPC 绑定字段（supportedInterfaces 非 JSON-RPC）抛错并携带违规点', () => {
    expect(() => validateAgentCard(card({ supportedInterfaces: [{ protocolBinding: 'JSONRPC' }] }))).toThrow(
      'invalid agent card'
    );
  });

  it.each([
    ['name 缺失', card({ name: '' })],
    ['version 缺失', card({ version: '' })],
    ['capabilities 缺失', card({ capabilities: undefined })],
    ['defaultInputModes 缺失', card({ defaultInputModes: undefined })],
    ['skills 条目缺 id', card({ skills: [{ name: 'x', description: 'y' }] })],
  ])('%s 时抛错', (_label, value) => {
    expect(() => validateAgentCard(value)).toThrow('invalid agent card');
  });

  it('tags 中的非字符串项被过滤（宽松容错）', () => {
    const validated = validateAgentCard(
      card({ skills: [{ id: 'a', name: 'b', description: 'c', tags: ['ok', 42, null] }] })
    );
    expect(validated.skills[0]!.tags).toEqual(['ok']);
  });

  it('v0.x 兼容：无 supportedInterfaces 时用顶层 url + preferredTransport 合成接口（Dify 形态）', () => {
    const legacy = validateAgentCard(
      card({
        supportedInterfaces: undefined,
        url: 'http://localhost/chat/uMAbNzWEVpC0bPa6',
        preferredTransport: 'JSONRPC',
        protocolVersion: '0.3.0',
      })
    );
    expect(legacy.supportedInterfaces).toHaveLength(1);
    expect(legacy.supportedInterfaces[0]!.url).toBe('http://localhost/chat/uMAbNzWEVpC0bPa6');
    expect(legacy.supportedInterfaces[0]!.protocolBinding).toBe('JSONRPC');
    expect(legacy.supportedInterfaces[0]!.protocolVersion).toBe('0.3.0');
  });

  it('v0.x 兼容：preferredTransport 缺省按 JSONRPC 处理', () => {
    const legacy = validateAgentCard(
      card({ supportedInterfaces: undefined, url: 'https://a2a.example.com/', protocolVersion: '0.3.0' })
    );
    expect(legacy.supportedInterfaces[0]!.protocolBinding).toBe('JSONRPC');
  });

  it('v0.x 兼容：preferredTransport 非 JSON-RPC 绑定时抛错', () => {
    expect(() =>
      validateAgentCard(
        card({ supportedInterfaces: undefined, url: 'https://x', preferredTransport: 'GRPC' })
      )
    ).toThrow('JSON-RPC');
  });

  it('v0.x 兼容：顶层 url 也缺失时抛错', () => {
    expect(() => validateAgentCard(card({ supportedInterfaces: undefined }))).toThrow('invalid agent card');
  });
});

describe('isHttpUrl', () => {
  it.each([
    ['https://a2a.example.com/card.json', true],
    ['http://localhost:9100/.well-known/agent-card.json', true],
    ['ftp://example.com', false],
    ['not a url', false],
    ['', false],
  ])('%s → %s', (input, expected) => {
    expect(isHttpUrl(input)).toBe(expected);
  });
});

describe('isTerminalTaskState', () => {
  it.each([
    ['completed', true],
    ['failed', true],
    ['canceled', true],
    ['working', false],
    ['submitted', false],
    ['input-required', false],
  ])('%s → %s', (state, expected) => {
    expect(isTerminalTaskState(state as never)).toBe(expected);
  });
});

describe('validateA2aTask', () => {
  it('合法 task 通过', () => {
    const task = validateA2aTask({ id: 't1', status: { state: 'completed' } });
    expect(task.id).toBe('t1');
    expect(task.status.state).toBe('completed');
  });

  it.each([
    ['非对象', 'nope'],
    ['缺 id', { status: { state: 'completed' } }],
    ['缺 status', { id: 't1' }],
    ['status 缺 state', { id: 't1', status: {} }],
  ])('%s 时抛错', (_label, value) => {
    expect(() => validateA2aTask(value)).toThrow('invalid a2a task');
  });
});

describe('partToText / messageToText', () => {
  it('text 部件返回原文', () => {
    expect(partToText({ kind: 'text', text: '你好' })).toBe('你好');
  });

  it('file 部件文本化为占位标注（P0 不读内容）', () => {
    const text = partToText({ kind: 'file', name: 'a.pdf', mimeType: 'application/pdf' });
    expect(text).toContain('a.pdf');
    expect(text).toContain('application/pdf');
    expect(text).toContain('文件部件');
  });

  it('data 部件序列化为带标注 JSON', () => {
    const text = partToText({ kind: 'data', data: { answer: 42 } });
    expect(text).toContain('数据部件');
    expect(text).toContain('"answer":42');
  });

  it('未知 kind 文本化时保留类型标记', () => {
    expect(partToText({ kind: 'weird' })).toContain('weird');
  });

  it('messageToText 跳过空部件并换行拼接', () => {
    expect(
      messageToText({ role: 'agent', parts: [{ kind: 'text', text: '第一行' }, { kind: 'text', text: '第二行' }] })
    ).toBe('第一行\n第二行');
  });

  it('messageToText 对 undefined/无 parts 消息返回空串', () => {
    expect(messageToText(undefined)).toBe('');
    expect(messageToText({ role: 'agent', parts: [] })).toBe('');
  });
});
