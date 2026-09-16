// Dify REST API 领域类型与运行时校验（共享库 webmcp-agent-chat-core，2026-09-16 协议配置扩展）。
//
// 职责：Dify chat-messages 请求/响应的消费字段子集与网络数据校验。
// 协议基线：Dify Service API（POST /v1/chat-messages，Authorization: Bearer {api_key}，
// 官方文档 docs.dify.ai，2026-09-16 核验）。仅取本扩展实际消费的字段，未知字段不校验不透传。
//
// 边界红线：纯类型/纯函数，零 Vue、零 chrome.*、零宿主依赖（C7/C8）；
// 网络数据不可信，所有进入领域逻辑的远端结构必须先经本模块校验。

/** blocking 模式的完整响应（application/json，ChatCompletionResponse 消费子集）。 */
export interface DifyChatCompletionResponse {
  /** 事件类型，blocking 固定为 'message'。 */
  event?: unknown;
  /** 完整回复内容（必消费）。 */
  answer: string;
  /** 会话 ID（续传必消费；缺省 = 未产生会话）。 */
  conversation_id?: string;
  /** 元数据（usage / retriever_resources，P0 不消费，仅透传日志计数）。 */
  metadata?: unknown;
}

/** SSE 事件流单事件（text/event-stream，data JSON 的消费子集）。 */
export interface DifyStreamEvent {
  /** 事件类型：message / agent_message / message_end / error / ping / 其它（忽略）。 */
  event?: unknown;
  /** 本次累积的文本分片（message / agent_message）；message_replace 为整体替换。 */
  answer?: unknown;
  /** 会话 ID（首个事件即返回，message_end 再次确认）。 */
  conversation_id?: unknown;
  /** error 事件的人类可读信息。 */
  message?: unknown;
  /** error 事件的业务状态码。 */
  status?: unknown;
}

/** 校验 blocking 响应：answer 必须为字符串；失败抛错（调用方包装为 A2aClientError）。 */
export function validateDifyChatResponse(value: unknown): DifyChatCompletionResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('dify chat response: root is not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['answer'] !== 'string') {
    throw new Error('dify chat response: answer is not a string');
  }
  const conversationId = record['conversation_id'];
  if (conversationId !== undefined && typeof conversationId !== 'string') {
    throw new Error('dify chat response: conversation_id is not a string');
  }
  return value as DifyChatCompletionResponse;
}

/** 校验 SSE 单事件 JSON：data 必须为对象；失败抛错（调用方按 invalid-response 处理）。 */
export function validateDifyStreamEvent(value: unknown): DifyStreamEvent {
  if (typeof value !== 'object' || value === null) {
    throw new Error('dify stream event: data is not an object');
  }
  return value as DifyStreamEvent;
}

/** 判定 SSE 事件类型是否为文本分片（message = Chat 应用，agent_message = Agent 应用）。 */
export function isDifyTextChunkEvent(event: unknown): boolean {
  return event === 'message' || event === 'agent_message';
}
