// MAIN world SDK：window.webmcpAgent 命名空间（D2 决策，独立于 navigator.modelContext ——
// 后者是 WebMCP 工具注册语义，页签反调是「页面消费扩展能力」，混用会互相污染）。
//
// 运行环境 = 页面 MAIN world（与页面共享 JS 环境）：
// - 零特权 API、零凭证；跨世界通信只走 window.postMessage（CS 侧监听转发）；
// - 页面可篡改本命名空间或伪造应答（仅能欺骗本页自己的请求，自伤不越权）——
//   信任边界见探索文档 §6，MAIN world 反篡改不做强承诺；
// - 入参必须可结构化克隆（普通对象/数组/原始值；函数、DOM 节点会抛 DataCloneError）。
//
// Promise 语义（Q1，终态落定）：task-ack 不落定（仅受理回执）；task-done resolve；
// task-error reject（错误对象带 code 字段，页面按协议错误码分支）。扩展侧失联时
// 由 content script 桥接补发 task-error（EXTENSION_HOST_UNAVAILABLE），不悬挂。
// 拉取（C6 R4/Q11-Q12）：asyncAgentInitialization 复用同一 pending 通道，init-data 直接
// resolve；init 无 ack，SDK 侧 10s 兜底超时防宿主无应答悬挂。
import type { AgentInitPayload } from 'webmcp-agent-chat-core';
import {
  isAgentTaskHostReplyMessage,
  type AgentTaskAgentInput,
  type AgentTaskResultPayload,
  type AgentTaskToolInput,
} from '../core/agent-task-protocol';

/** 页面 → CS 的 window.postMessage 来源标记。 */
const SDK_SOURCE = 'webmcp-agent-task-sdk';
/** CS → 页面的 window.postMessage 来源标记（SDK 只接受带此标记的应答）。 */
const BRIDGE_SOURCE = 'webmcp-agent-task-bridge';

/** SDK 抛出的任务错误（携带协议错误码，页面按 code 分支处理）。 */
export class AgentTaskSdkError extends Error {
  constructor(
    /** 协议错误码（如 ORIGIN_NOT_ALLOWED / QUEUE_FULL / TASK_TIMED_OUT）。 */
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentTaskSdkError';
  }
}

/** 页签反调任务入参（与 core/agent-task-protocol.ts 输入契约同构，类型单点同步）。 */
export type AgentTaskSdkInput = AgentTaskAgentInput | AgentTaskToolInput;

/** 拉取兜底超时（C6 Q12：宿主无应答/链路断裂时 Promise 必须落定）。 */
export const AGENT_INITIALIZATION_TIMEOUT_MS = 10_000;

/** window.webmcpAgent 命名空间（扩展 MAIN world SDK 注入；缺失 = 扩展未安装或未含本特性）。 */
export interface WebMcpAgentSdk {
  /**
   * 发起后台 agent / tool 任务（默认创建新会话后台运行，R4）。
   *
   * @returns 终态落定的 Promise：resolve 值为 `{ taskId, sessionId, status, result }`；
   *          status ∈ completed / failed / cancelled；agent 任务 result 为最终回复文本，
   *          tool 任务 result 为工具执行结果原样透传。
   * @throws AgentTaskSdkError（带 code）—— 受理前失败（白名单/参数/宿主不可用）或执行失败。
   */
  asyncCreateAgentTask(input: AgentTaskSdkInput): Promise<AgentTaskResultPayload>;
  /**
   * 拉取初始化数据（C6 R4：与 web_mcp_agent_initialization 推送载荷同 schema 同白名单；
   * 返回调用时刻的最新快照）。无任务语义：不建会话、不进队列。
   *
   * @returns 初始化载荷 `{ version, pushedAt, currentAgent, agents, a2aAgents, skills, tools }`。
   * @throws AgentTaskSdkError（带 code）—— 白名单拒绝 / 宿主不可用 / 10s 兜底超时（TASK_TIMED_OUT）。
   */
  asyncAgentInitialization(): Promise<AgentInitPayload>;
}

/** 请求 id：req_<时间戳base36>_<自增>_<6位随机>（本页唯一即可，跨页由宿主重生成 taskId）。 */
function nextRequestId(seq: { value: number }): string {
  seq.value += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `req_${Date.now().toString(36)}_${seq.value}_${random}`;
}

/** 挂载 SDK（幂等：window.webmcpAgent 已存在时不覆盖 —— 兼容未来原生实现或重复注入）。 */
export function installAgentTaskSdk(): void {
  if (typeof window === 'undefined') return;
  if (window.webmcpAgent) return;

  const seq = { value: 0 };
  /** requestId → 落定器（task-done/init-data/task-error 时取用并移除；任务与拉取共用）。 */
  const pending = new Map<string, {
    resolve: (value: AgentTaskResultPayload | AgentInitPayload) => void;
    reject: (error: AgentTaskSdkError) => void;
  }>();

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const record = data as Record<string, unknown>;
    if (record['source'] !== BRIDGE_SOURCE) return;
    // 结构守卫只认 type + requestId；source 标记为 CS 桥接附加字段，宽容放行
    if (!isAgentTaskHostReplyMessage(data)) return;
    const waiter = pending.get(data.requestId);
    if (!waiter) return;
    if (data.type === 'task-ack') return; // 受理回执不落定（Q1：终态 Promise）
    pending.delete(data.requestId);
    if (data.type === 'task-done') {
      waiter.resolve({
        taskId: data.taskId,
        sessionId: data.sessionId,
        status: data.status,
        result: data.result,
      });
      return;
    }
    if (data.type === 'init-data') {
      waiter.resolve(data.payload);
      return;
    }
    waiter.reject(new AgentTaskSdkError(data.code, data.message));
  });

  const sdk: WebMcpAgentSdk = {
    asyncCreateAgentTask(input) {
      return new Promise<AgentTaskResultPayload>((resolve, reject) => {
        let payload: unknown;
        try {
          // 结构化克隆预检：函数/DOM 节点等不可克隆入参在发起侧即报错，不进通道
          payload = structuredClone(input);
        } catch (error) {
          reject(
            new AgentTaskSdkError(
              'INVALID_PARAMS',
              `任务入参不可结构化克隆（须为普通对象/数组/原始值）：${error instanceof Error ? error.message : String(error)}`
            )
          );
          return;
        }
        const requestId = nextRequestId(seq);
        // Map 落定器接受联合类型；本分支只产出任务结果（包装以匹配 resolve 逆变）
        pending.set(requestId, { resolve: (value) => resolve(value as AgentTaskResultPayload), reject });
        try {
          window.postMessage({ source: SDK_SOURCE, type: 'create-task', requestId, payload }, '*');
        } catch (error) {
          pending.delete(requestId);
          reject(new AgentTaskSdkError('PROTOCOL_MISMATCH', `任务请求发送失败：${error instanceof Error ? error.message : String(error)}`));
        }
      });
    },
    asyncAgentInitialization() {
      // 无入参 → 无需结构化克隆预检（Q12：10s 兜底超时，落定即清定时器）
      return new Promise<AgentInitPayload>((resolve, reject) => {
        const requestId = nextRequestId(seq);
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new AgentTaskSdkError('TASK_TIMED_OUT', '初始化数据拉取超时（宿主无应答）'));
        }, AGENT_INITIALIZATION_TIMEOUT_MS);
        pending.set(requestId, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as AgentInitPayload);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          window.postMessage({ source: SDK_SOURCE, type: 'init-request', requestId }, '*');
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(new AgentTaskSdkError('PROTOCOL_MISMATCH', `拉取请求发送失败：${error instanceof Error ? error.message : String(error)}`));
        }
      });
    },
  };

  window.webmcpAgent = sdk;
}

// Window 类型增强（本包 MAIN world 侧的事实源；html-app 侧镜像最小声明）。
declare global {
  interface Window {
    webmcpAgent?: WebMcpAgentSdk;
  }
}
