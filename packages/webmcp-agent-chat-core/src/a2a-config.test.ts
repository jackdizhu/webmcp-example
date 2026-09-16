// a2a-config 领域模块单测：整表严格校验（load/save 收口）+ 防御式净化（旧档案迁移）
// + 协议分支校验（2026-09-16：jsonrpc / dify 双协议条目）。
import { describe, expect, it } from 'vitest';
import {
  a2aRefProtocol,
  sanitizeA2aRefs,
  validateA2aConfigValue,
  type AgentA2aRef,
} from './a2a-config';

const ref = (overrides: Partial<AgentA2aRef> = {}): AgentA2aRef => ({
  id: 'dify_app',
  cardUrl: 'https://x.example.com/.well-known/agent-card.json',
  enabled: true,
  ...overrides,
});

const difyRef = (overrides: Partial<AgentA2aRef> = {}): AgentA2aRef => ({
  id: 'weather-dify',
  enabled: true,
  protocol: 'dify',
  endpoint: 'https://api.dify.example.com/v1/chat-messages',
  ...overrides,
});

describe('a2aRefProtocol', () => {
  it('缺省回落 jsonrpc（旧数据零迁移）', () => {
    expect(a2aRefProtocol({})).toBe('jsonrpc');
    expect(a2aRefProtocol({ protocol: 'dify' })).toBe('dify');
    expect(a2aRefProtocol({ protocol: 'jsonrpc' })).toBe('jsonrpc');
  });
});

describe('validateA2aConfigValue', () => {
  it('合法配置通过并原样返回（jsonrpc + dify 混合）', () => {
    const refs = [
      ref(),
      ref({ id: 'doc-agent', enabled: false, endpointOverride: 'http://localhost/e/app/a2a' }),
      difyRef(),
      difyRef({
        id: 'chatflow',
        responseMode: 'blocking',
        displayName: '天气助手',
        description: '查询城市天气',
        inputs: { city: '北京' },
      }),
    ];
    expect(validateA2aConfigValue(structuredClone(refs))).toEqual(refs);
  });

  it.each([
    ['root 非数组', 'not-an-array', 'root'],
    ['条目非对象', [null], 'invalid entry'],
    ['id 缺失', [{ cardUrl: 'https://x/card.json', enabled: true }], 'invalid entry'],
    ['cardUrl 为空串', [ref({ cardUrl: '' })], 'invalid entry'],
    ['enabled 非布尔', [{ ...ref(), enabled: 1 } as unknown as AgentA2aRef], 'invalid entry'],
    ['endpointOverride 空串', [ref({ endpointOverride: '' })], 'invalid entry'],
    ['protocol 非法枚举', [{ ...ref(), protocol: 'grpc' } as unknown as AgentA2aRef], 'invalid entry'],
    ['dify 条目缺 endpoint', [{ id: 'x', enabled: true, protocol: 'dify' } as unknown as AgentA2aRef], 'invalid entry'],
    ['dify 条目 endpoint 空串', [difyRef({ endpoint: '' })], 'invalid entry'],
    ['dify 条目 responseMode 非法', [difyRef({ responseMode: 'push' } as unknown as Partial<AgentA2aRef>)], 'invalid entry'],
    ['dify 条目 inputs 非对象', [difyRef({ inputs: [1, 2] } as unknown as Partial<AgentA2aRef>)], 'invalid entry'],
    ['dify 条目 displayName 非字符串', [difyRef({ displayName: 1 } as unknown as Partial<AgentA2aRef>)], 'invalid entry'],
  ])('非法配置 %s 抛错（含 %s）', (_label, value, reason) => {
    expect(() => validateA2aConfigValue(value)).toThrow(new RegExp(reason));
  });
});

describe('sanitizeA2aRefs', () => {
  it('逐条提取合法引用，endpointOverride 缺省时不携带该字段', () => {
    const { refs, dropped } = sanitizeA2aRefs([
      ref(),
      ref({ id: 'b', endpointOverride: 'http://localhost/e/app/a2a' }),
    ]);
    expect(dropped).toBe(0);
    expect(refs).toEqual([
      ref(),
      { id: 'b', cardUrl: ref().cardUrl, enabled: true, endpointOverride: 'http://localhost/e/app/a2a' },
    ]);
  });

  it('dify 条目全字段提取；可选字段缺省时不携带', () => {
    const { refs, dropped } = sanitizeA2aRefs([
      difyRef(),
      difyRef({
        id: 'chatflow',
        responseMode: 'blocking',
        displayName: '助手',
        description: '描述',
        inputs: { k: 'v' },
      }),
    ]);
    expect(dropped).toBe(0);
    expect(refs).toEqual([
      { id: 'weather-dify', enabled: true, protocol: 'dify', endpoint: difyRef().endpoint },
      {
        id: 'chatflow',
        enabled: true,
        protocol: 'dify',
        endpoint: difyRef().endpoint,
        responseMode: 'blocking',
        displayName: '助手',
        description: '描述',
        inputs: { k: 'v' },
      },
    ]);
  });

  it('非法条目静默丢弃并计数（迁移路径不抛错；含 dify 非法分支）', () => {
    const { refs, dropped } = sanitizeA2aRefs([
      ref(),
      null,
      'garbage',
      { id: '', cardUrl: 'https://x/card.json', enabled: true },
      { id: 'ok-id', enabled: true },
      { id: 'bad-token', cardUrl: 'https://x/card.json', enabled: 'yes' },
      ref({ id: 'dup', endpointOverride: '' }),
      { id: 'dify-no-endpoint', enabled: true, protocol: 'dify' },
      { id: 'dify-bad-mode', enabled: true, protocol: 'dify', endpoint: 'https://x/chat', responseMode: 'push' },
      { id: 'bad-protocol', enabled: true, protocol: 'grpc', cardUrl: 'https://x/card.json' },
    ]);
    expect(refs).toEqual([ref()]);
    expect(dropped).toBe(9);
  });

  it('id 重复时保留首个（agentKey 全局唯一语义）', () => {
    const { refs, dropped } = sanitizeA2aRefs([
      ref({ cardUrl: 'https://first.example.com/card.json' }),
      ref({ cardUrl: 'https://second.example.com/card.json' }),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.cardUrl).toBe('https://first.example.com/card.json');
    expect(dropped).toBe(1);
  });

  it('非数组输入返回空（旧档案缺字段场景）', () => {
    expect(sanitizeA2aRefs(undefined)).toEqual({ refs: [], dropped: 0 });
    expect(sanitizeA2aRefs('oops')).toEqual({ refs: [], dropped: 0 });
  });
});
