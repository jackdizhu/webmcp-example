// agent-task-protocol 单测：入参校验纯函数、线消息守卫、错误码/终态守卫、taskId 生成。
import { describe, expect, it } from 'vitest';
import {
  AGENT_TASK_ERROR_CODES,
  createTaskId,
  isAgentTaskErrorCode,
  isAgentTaskHostReplyMessage,
  isAgentTaskTabMessage,
  isTaskTerminalStatus,
  validateAgentTaskInput,
  validateAgentTaskPayload,
  validateToolTaskInput,
} from './agent-task-protocol';

describe('validateAgentTaskInput（agent 任务入参）', () => {
  it('agentName + agentPrompt 合法：归一化 trim 且 taskType 固定 agent', () => {
    const result = validateAgentTaskInput({
      taskType: 'agent',
      agentName: ' 通用智能体 ',
      agentPrompt: ' 读取大纲 ',
    });
    expect(result).toEqual({
      ok: true,
      input: { taskType: 'agent', agentName: '通用智能体', agentPrompt: '读取大纲' },
    });
  });

  it('agentId 优先（Q8）：无 agentName 也受理，且 agentName 归一为空串', () => {
    const result = validateAgentTaskInput({ agentId: ' a2a-analyst ', agentPrompt: 'p' });
    expect(result).toEqual({
      ok: true,
      input: { taskType: 'agent', agentName: '', agentPrompt: 'p', agentId: 'a2a-analyst' },
    });
  });

  it('agentName 与 agentId 都缺失 → INVALID_PARAMS', () => {
    const result = validateAgentTaskInput({ agentPrompt: 'p' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PARAMS');
  });

  it('agentPrompt 缺失/空白 → INVALID_PARAMS', () => {
    for (const input of [{ agentName: 'x' }, { agentName: 'x', agentPrompt: '   ' }]) {
      const result = validateAgentTaskInput(input);
      expect(result.ok).toBe(false);
    }
  });

  it('skillName 可选且 trim；宽容未知字段', () => {
    const result = validateAgentTaskInput({
      agentName: 'x',
      agentPrompt: 'p',
      skillName: ' 页面工具使用指南 ',
      unknownField: 1,
    });
    expect(result).toEqual({
      ok: true,
      input: { taskType: 'agent', agentName: 'x', agentPrompt: 'p', skillName: '页面工具使用指南' },
    });
  });

  it('非对象入参 → INVALID_PARAMS', () => {
    expect(validateAgentTaskInput(null).ok).toBe(false);
    expect(validateAgentTaskInput('x').ok).toBe(false);
  });
});

describe('validateToolTaskInput（tool 任务入参）', () => {
  it('toolName + toolProps 合法；toolProps 缺省归一为空对象', () => {
    expect(validateToolTaskInput({ taskType: 'tool', toolName: ' echo ', toolProps: { a: 1 } })).toEqual({
      ok: true,
      input: { taskType: 'tool', toolName: 'echo', toolProps: { a: 1 } },
    });
    expect(validateToolTaskInput({ toolName: 'echo' })).toEqual({
      ok: true,
      input: { taskType: 'tool', toolName: 'echo', toolProps: {} },
    });
  });

  it('toolProps 为数组/null/字符串 → INVALID_PARAMS', () => {
    for (const toolProps of [[1], null, 'x']) {
      const result = validateToolTaskInput({ toolName: 'echo', toolProps });
      expect(result.ok).toBe(false);
    }
  });

  it('toolName 缺失/空白 → INVALID_PARAMS', () => {
    expect(validateToolTaskInput({}).ok).toBe(false);
    expect(validateToolTaskInput({ toolName: '  ' }).ok).toBe(false);
  });
});

describe('validateAgentTaskPayload（按 taskType 分发）', () => {
  it('taskType=agent / tool 分别路由', () => {
    expect(validateAgentTaskPayload({ taskType: 'agent', agentName: 'x', agentPrompt: 'p' }).ok).toBe(true);
    expect(validateAgentTaskPayload({ taskType: 'tool', toolName: 'x' }).ok).toBe(true);
  });

  it('taskType 非法 → INVALID_PARAMS', () => {
    const result = validateAgentTaskPayload({ taskType: 'other' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PARAMS');
  });
});

describe('线消息与枚举守卫', () => {
  it('isAgentTaskTabMessage：create-task/heartbeat/cancel-task 放行，其余拒绝', () => {
    expect(isAgentTaskTabMessage({ type: 'create-task', requestId: 'r1', payload: {} })).toBe(true);
    expect(isAgentTaskTabMessage({ type: 'heartbeat', requestId: 'r1', ts: 1 })).toBe(true);
    expect(isAgentTaskTabMessage({ type: 'cancel-task', requestId: 'r1', taskId: 't' })).toBe(true);
    expect(isAgentTaskTabMessage({ type: 'task-done', requestId: 'r1' })).toBe(false);
    expect(isAgentTaskTabMessage({ type: 'create-task' })).toBe(false);
    expect(isAgentTaskTabMessage(null)).toBe(false);
  });

  it('isAgentTaskHostReplyMessage：ack/done/error 放行，其余拒绝', () => {
    expect(isAgentTaskHostReplyMessage({ type: 'task-ack', requestId: 'r1', taskId: 't', sessionId: 's' })).toBe(true);
    expect(isAgentTaskHostReplyMessage({ type: 'task-done', requestId: 'r1', taskId: 't', sessionId: 's', status: 'completed', result: null })).toBe(true);
    expect(isAgentTaskHostReplyMessage({ type: 'task-error', requestId: 'r1', code: 'INVALID_PARAMS', message: 'm' })).toBe(true);
    expect(isAgentTaskHostReplyMessage({ type: 'create-task', requestId: 'r1' })).toBe(false);
  });

  it('isTaskTerminalStatus / isAgentTaskErrorCode', () => {
    expect(isTaskTerminalStatus('completed')).toBe(true);
    expect(isTaskTerminalStatus('running')).toBe(false);
    expect(isAgentTaskErrorCode('QUEUE_FULL')).toBe(true);
    expect(isAgentTaskErrorCode('NOPE')).toBe(false);
    expect(AGENT_TASK_ERROR_CODES).toHaveLength(12);
  });
});

describe('createTaskId', () => {
  it('格式 task_<时间戳base36>_<6位随机>；随机源固定时可复现', () => {
    const id = createTaskId(1_000, () => 0.5);
    expect(id).toBe(`task_${(1_000).toString(36)}_ssssss`);
    expect(createTaskId()).toMatch(/^task_[a-z0-9]+_[a-z0-9]{6}$/);
  });
});
