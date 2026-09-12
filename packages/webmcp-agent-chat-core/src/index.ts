// 共享库入口：agent 对话领域的全部公共导出。
export {
  AgentAbortError,
  DEFAULT_SYSTEM_PROMPT,
  runAgentLoop,
  trimHistory,
  type AgentLoopDeps,
  type AgentLoopEvent,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentTool,
  type ChatMessage,
  type ChatRole,
  type LlmChatClient,
  type ToolCallRequest,
} from './agent-loop';
export {
  API_PATH_EMPTY_HINT,
  createAnthropicClient,
  createLlmClient,
  createOpenAiCompatClient,
  toAnthropicMessages,
  toWireMessages,
  toWireTools,
  type LlmConfig,
  type LlmLogFn,
} from './llm-client';
export {
  ABORTED_TURN_TEXT,
  createChatController,
  type ChatController,
  type ChatControllerDeps,
  type ChatTurnView,
} from './chat-controller';
