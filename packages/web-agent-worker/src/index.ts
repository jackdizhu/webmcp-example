// 主线程导出入口：createWebAgentClient + 协议/配置/loop 类型。
export {
  createWebAgentClient,
  WebAgentRequestError,
  type WebAgentChatResult,
  type WebAgentClient,
  type WebAgentRunAgentResult,
  type WebAgentTempTool,
} from './client';
export {
  isWebAgentWorkerErrorCode,
  validateMainToWorkerMessage,
  validateWorkerToMainMessage,
  WebAgentWorkerError,
  type MainToWorkerMessage,
  type WebAgentAgentDoneMessage,
  type WebAgentChatDoneMessage,
  type WebAgentChatFormat,
  type WebAgentChatInput,
  type WebAgentChunkMessage,
  type WebAgentDifyConfig,
  type WebAgentDifyToolConfig,
  type WebAgentLoopConfig,
  type WebAgentRunAgentInput,
  type WebAgentTempToolDef,
  type WebAgentTimeoutsConfig,
  type WebAgentWorkerConfig,
  type WebAgentWorkerErrorCode,
  type WorkerToMainMessage,
} from './protocol';
export {
  AgentAbortError,
  DEFAULT_SYSTEM_PROMPT,
  runAgentLoop,
  trimHistory,
  type AgentLoopDeps,
  type AgentLoopEvent,
  type AgentLoopOptions,
  type AgentLoopParams,
  type AgentLoopResult,
  type AgentTool,
  type ChatMessage,
  type ChatRole,
  type LlmChatClient,
  type ToolCallRequest,
} from './loop/agent-loop';
export {
  API_PATH_EMPTY_HINT,
  createLlmClient,
  type LlmConfig,
  type LlmLogFn,
} from './loop/llm-client';
export {
  appendLog,
  createCallLogger,
  type CallLogger,
} from './logging/call-logger';
export {
  computeRotateCount,
  truncateContent,
  MAX_CONTENT_LENGTH,
  MAX_LOG_RECORDS,
  ROTATE_MARGIN,
} from './logging/logger-core';
export {
  createLazyLogStorage,
  createLoggerDb,
  openLoggerDb,
} from './logging/logger-db';
export type {
  CallLogEntry,
  CallLogPhase,
  LogStorage,
} from './logging/logger-types';
