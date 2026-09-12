// A2A v1.0 协议纯类型与运行时校验（共享库 webmcp-agent-chat-core）。
//
// 职责：Agent Card / Task / Message / Part 的领域类型定义与网络数据校验。
// 协议基线：A2A v1.0（Linux Foundation Agentic AI Foundation，JSON-RPC 2.0 主绑定）。
// 仅取本扩展实际消费的字段子集（spec 全量字段见官方 a2a.json schema），未知字段
// 不校验不透传 —— 收窄消费面以换取稳定的错误分型。
//
// 边界红线：纯类型/纯函数，零 Vue、零 chrome.*、零宿主依赖（C7/C8）；
// 网络数据不可信，所有进入领域逻辑的远端结构必须先经本模块校验。
// 设计文档：docs/webmcp-a2a-agent-protocol-design.md（§5 D2/D5，2026-09-12 定稿）。

// ---- Agent Card（发现清单，GET /.well-known/agent-card.json）----

/** 远端 agent 暴露的单项技能（用于拼接工具 description，帮助模型选择）。 */
export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

/** Agent Card 的传输接口声明（仅消费 JSON-RPC 绑定，其余绑定忽略）。 */
export interface AgentCardInterface {
  url: string;
  protocolBinding: string;
  protocolVersion?: string;
}

/** 能力开关（本扩展消费 streaming 与 pushNotifications 两个字段，P0 不做流式与推送）。 */
export interface AgentCardCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
}

/** A2A Agent Card（校验后形态：本扩展消费的必选/可选字段子集）。 */
export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: AgentCardInterface[];
  capabilities: AgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
}

/** JSON-RPC 绑定的优先级排序键（本扩展仅支持 JSON-RPC over HTTP(S)）。 */
const SUPPORTED_BINDING = 'jsonrpc';

/**
 * 运行时校验 Agent Card（网络数据不可信）。
 *
 * 抛错携带首个违规点描述；校验通过返回**规范化**卡片：
 * - supportedInterfaces 过滤出 JSON-RPC 绑定（协议版本缺省按 v1.0 处理），全部不兼容则抛错；
 *   字段缺失时按 v0.x 规范回退（顶层 url + preferredTransport + protocolVersion 合成单条接口，
 *   兼容 Dify 等存量实现）；
 * - 其余必选字段仅做类型与非空校验，原样保留。
 */
export function validateAgentCard(value: unknown): AgentCard {
  const fail = (reason: string): never => {
    throw new Error(`invalid agent card: ${reason}`);
  };
  if (typeof value !== 'object' || value === null) fail('root is not an object');
  const card = value as Record<string, unknown>;
  /** 非空字符串提取（直接 throw 收窄，不依赖跨作用域的 never 函数控制流分析）。 */
  const requireString = (v: unknown, reason: string): string => {
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(`invalid agent card: ${reason}`);
    }
    return v;
  };
  /** 字符串提取（允许空串）。 */
  const requireLooseString = (v: unknown, reason: string): string => {
    if (typeof v !== 'string') {
      throw new Error(`invalid agent card: ${reason}`);
    }
    return v;
  };

  const name = requireString(card['name'], 'name is not a non-empty string');
  const description = requireLooseString(card['description'], 'description is not a string');
  const version = requireString(card['version'], 'version is not a non-empty string');

  // ---- supportedInterfaces（v1.0 规范字段）----
  // v0.x 兼容（Dify 等存量实现，protocolVersion ≤0.3.0）：无 supportedInterfaces 字段时，
  // 用顶层 url（JSON-RPC 端点）+ preferredTransport（如 "JSONRPC"）+ protocolVersion
  // 合成单条接口再走统一校验。preferredTransport 缺省按 JSONRPC 处理；若声明的是
  // 其它绑定（如 GRPC），合成后不含 JSON-RPC 绑定，走既有的「无兼容绑定」报错。
  let interfacesRaw: unknown = card['supportedInterfaces'];
  if (interfacesRaw === undefined) {
    const legacyUrl = typeof card['url'] === 'string' ? card['url'] : '';
    if (legacyUrl.trim().length === 0) {
      fail('supportedInterfaces is not an array (v0.x 兼容：顶层 url 也缺失，无法合成接口)');
    }
    const legacyTransport =
      typeof card['preferredTransport'] === 'string' && card['preferredTransport'].trim().length > 0
        ? card['preferredTransport']
        : 'JSONRPC';
    interfacesRaw = [
      {
        url: legacyUrl,
        protocolBinding: legacyTransport,
        ...(typeof card['protocolVersion'] === 'string' ? { protocolVersion: card['protocolVersion'] } : {}),
      },
    ];
  }
  if (!Array.isArray(interfacesRaw)) fail('supportedInterfaces is not an array');
  const jsonrpcInterfaces: AgentCardInterface[] = [];
  for (const item of interfacesRaw as unknown[]) {
    if (typeof item !== 'object' || item === null) fail('supportedInterfaces has a non-object entry');
    const it = item as Record<string, unknown>;
    const url = typeof it['url'] === 'string' ? it['url'] : '';
    if (url.trim().length === 0) fail('supportedInterfaces entry url is not a non-empty string');
    const binding = typeof it['protocolBinding'] === 'string' ? it['protocolBinding'] : '';
    if (binding.length === 0) fail('supportedInterfaces entry protocolBinding is not a string');
    if (binding.toLowerCase().includes(SUPPORTED_BINDING)) {
      jsonrpcInterfaces.push({
        url,
        protocolBinding: binding,
        ...(typeof it['protocolVersion'] === 'string' ? { protocolVersion: it['protocolVersion'] } : {}),
      });
    }
  }
  if (jsonrpcInterfaces.length === 0) {
    fail('no supportedInterfaces entry with a JSON-RPC binding');
  }

  const capabilitiesRaw = card['capabilities'];
  if (typeof capabilitiesRaw !== 'object' || capabilitiesRaw === null) fail('capabilities is not an object');
  const caps = capabilitiesRaw as Record<string, unknown>;
  const capabilities: AgentCardCapabilities = {
    streaming: caps['streaming'] === true,
    pushNotifications: caps['pushNotifications'] === true,
    extendedAgentCard: caps['extendedAgentCard'] === true,
  };

  const readStringArray = (field: string): string[] => {
    if (!Array.isArray(card[field])) fail(`${field} is not an array`);
    const values: string[] = [];
    for (const mode of card[field] as unknown[]) {
      if (typeof mode !== 'string') {
        throw new Error(`invalid agent card: ${field} has a non-string entry`);
      }
      values.push(mode);
    }
    return values;
  };
  const inputModes = readStringArray('defaultInputModes');
  const outputModes = readStringArray('defaultOutputModes');

  if (!Array.isArray(card['skills'])) fail('skills is not an array');
  const skills: AgentCardSkill[] = [];
  for (const item of card['skills'] as unknown[]) {
    if (typeof item !== 'object' || item === null) fail('skills has a non-object entry');
    const it = item as Record<string, unknown>;
    const id = requireString(it['id'], 'skills entry id is not a non-empty string');
    const skillName = requireString(it['name'], 'skills entry name is not a non-empty string');
    const skillDescription = requireLooseString(it['description'], 'skills entry description is not a string');
    const tags: string[] | undefined = Array.isArray(it['tags'])
      ? (it['tags'] as unknown[]).filter((tag): tag is string => typeof tag === 'string')
      : undefined;
    skills.push({ id, name: skillName, description: skillDescription, ...(tags !== undefined ? { tags } : {}) });
  }

  return {
    name,
    description,
    version,
    supportedInterfaces: jsonrpcInterfaces,
    capabilities,
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills,
  };
}

/** 判定 url 是否为 HTTP(S) 绝对地址（卡片 URL 与端点共同的安全底线，见设计 §5 D8）。 */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// ---- Task / Message / Part（message/send 与 tasks/get 的响应结构）----

/** 任务终态与中间态（spec 状态机子集；queued/auth-required P0 不消费）。 */
export type A2aTaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

/** 判定任务是否已到终态（终态后不再轮询/收流）。 */
export function isTerminalTaskState(state: A2aTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}

/** 文本部件（P0 仅消费 TextPart；File/Data Part 序列化为带标注文本块）。 */
export interface A2aTextPart {
  kind: 'text';
  text: string;
}

/** 文件部件（P0 不消费二进制内容，仅保留元数据文本化）。 */
export interface A2aFilePart {
  kind: 'file';
  name?: string;
  mimeType?: string;
  /** 文件内容（spec 为 file/fileWithBytes 二选一）；P0 一律文本化截断，不解析。 */
  raw?: unknown;
}

/** 数据部件（结构化 JSON 负载）。 */
export interface A2aDataPart {
  kind: 'data';
  data: unknown;
}

/** 消息部件（A2A Part 联合类型的宽松形态，未知 kind 保留原始标记）。 */
export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart | { kind: string };

/** A2A 消息（role: 'user' = 客户端发出，'agent' = 远端回复）。 */
export interface A2aMessage {
  role: 'user' | 'agent';
  parts: A2aPart[];
  messageId?: string;
  taskId?: string;
  contextId?: string;
}

/** 任务状态快照（task.status）。 */
export interface A2aTaskStatus {
  state: A2aTaskState;
  message?: A2aMessage;
  timestamp?: string;
}

/** A2A 任务（tasks/get 与 message/send 响应中的 task 对象）。 */
export interface A2aTask {
  id: string;
  contextId?: string;
  status: A2aTaskStatus;
  /** 任务累积产物（文本化后并入工具结果）。 */
  artifacts?: Array<{ id?: string; name?: string; parts?: A2aPart[] }>;
  /** 任务内的消息历史（P0 不消费，仅保留类型占位）。 */
  history?: A2aMessage[];
}

/** 校验远端 task 对象；失败抛错（调用方包装为 isError 工具结果）。 */
export function validateA2aTask(value: unknown): A2aTask {
  const fail = (reason: string): never => {
    throw new Error(`invalid a2a task: ${reason}`);
  };
  if (typeof value !== 'object' || value === null) fail('root is not an object');
  const task = value as Record<string, unknown>;
  if (typeof task['id'] !== 'string' || task['id'].length === 0) fail('id is not a non-empty string');
  const status = task['status'];
  if (typeof status !== 'object' || status === null) fail('status is not an object');
  const state = (status as Record<string, unknown>)['state'];
  if (typeof state !== 'string') fail('status.state is not a string');
  return value as A2aTask;
}

/** 部件文本化：TextPart 原文；File/Data/未知 kind 序列化为带标注的文本块（设计 §5 D4）。 */
export function partToText(part: A2aPart): string {
  if (part.kind === 'text' && typeof (part as A2aTextPart).text === 'string') {
    return (part as A2aTextPart).text;
  }
  if (part.kind === 'file') {
    const file = part as A2aFilePart;
    const meta = [file.name ?? '(未命名)', file.mimeType ?? '(未知类型)'].join(' · ');
    return `[文件部件：${meta}（P0 不支持读取文件内容）]`;
  }
  if (part.kind === 'data') {
    let serialized: string;
    try {
      serialized = JSON.stringify((part as A2aDataPart).data) ?? 'null';
    } catch {
      serialized = '(不可序列化)';
    }
    return `[数据部件] ${serialized}`;
  }
  return `[未知部件类型：${part.kind}]`;
}

/** 消息文本化：全部部件按序拼接（换行分隔）。 */
export function messageToText(message: A2aMessage | undefined): string {
  if (!message || !Array.isArray(message.parts)) return '';
  return message.parts.map(partToText).filter((text) => text.length > 0).join('\n');
}
