// 轮次编排控制器（共享库 webmcp-agent-chat-core）。
//
// 职责：把「一轮 agent 对话」的领域流程收口为可复用编排器 —— busy 守卫、配置缺失
// 检查、工具清单获取、LLM 客户端构建、历史裁剪、循环执行、终止与错误分型、历史维护。
// 宿主（如 side-panel App）经依赖注入提供工具源 / 配置 getter / UI 适配器与横切设施
//（traceId、执行锁、日志），本模块零 UI、零浏览器 API、零宿主模块依赖。
//
// 边界红线：不含 Vue 响应式（busy 变化经 onBusyChange 回调通知宿主）；不含 chrome.*；
// 日志经 onLog 注入（source 语义固定为 'chat'，payload 不含鉴权数据）。
import {
  AgentAbortError,
  runAgentLoop,
  trimHistory,
  type AgentLoopEvent,
  type AgentLoopOptions,
  type AgentTool,
  type ChatMessage,
  type LlmChatClient,
} from './agent-loop';
import { createLlmClient, API_PATH_EMPTY_HINT, type LlmConfig } from './llm-client';
import type { LlmLogFn } from './llm-client';

/** 单轮 UI 适配器：宿主实现，把循环过程事件与最终文案映射到自己的消息模型。 */
export interface ChatTurnView {
  /** 循环过程事件（tool_start / tool_result / tool_error），宿主回填工具痕迹。 */
  onEvent(event: AgentLoopEvent): void;
  /** 本轮最终文案（成功回复 / 终止提示 / 错误信息，唯一最终值）。 */
  setText(text: string): void;
}

/** 控制器依赖（全部注入，宿主用 getter 包装自己的响应式状态）。 */
export interface ChatControllerDeps {
  /** 获取当前工具清单（宿主自行刷新缓存与计数）。 */
  getTools(): Promise<AgentTool[]>;
  /** 执行单个工具（含内置工具路由）。 */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 当前 LLM 配置（apiKey/baseUrl/apiPath/model/apiProtocol/maxTokens）。 */
  getLlmConfig(): LlmConfig;
  /** 系统提示词；空串 = 使用 agent-loop 内置默认提示。 */
  getSystemPrompt(): string;
  /** 历史保留轮数上限（0 = 不裁剪）。 */
  getMaxHistoryTurns(): number;
  /** 用户消息落 UI。 */
  onUserMessage(text: string): void;
  /** 创建本轮 assistant 消息的 UI 适配器。 */
  createTurnView(): ChatTurnView;
  /** API Key 缺失（宿主负责引导，如跳设置页 + 提示消息），调用后本轮直接结束。 */
  onMissingApiKey(): void;
  /** apiPath 显式空串（同上）。 */
  onMissingApiPath(): void;
  /** busy 状态变化（宿主接执行锁）。 */
  onBusyChange?(busy: boolean): void;
  /** 轮次开始（宿主接 traceId 等横切设施）。 */
  onTurnStart?(): void;
  /** 轮次收尾（成功/失败/终止均会调用，宿主清理横切设施）。 */
  onTurnSettled?(): void;
  /** LLM 客户端工厂（测试注入桩；缺省用库内 createLlmClient + 全局 fetch）。 */
  createLlm?(config: LlmConfig): LlmChatClient;
  /** 日志钩子（event：turn_start / turn_end / turn_aborted / turn_error / turn_abort_requested）。 */
  onLog?: LlmLogFn;
}

export interface ChatController {
  isBusy(): boolean;
  /** 终止当前轮（无进行中轮次时静默；正在执行的页面工具调用无法真正中断）。 */
  abort(): void;
  /** 跨轮对话历史（不含 system 消息；只读视图）。 */
  getHistory(): readonly ChatMessage[];
  /** 清空历史（切换智能体开新会话等场景）。 */
  clearHistory(): void;
  /** 运行一轮对话。跨域执行锁（如 relay 调用进行中）由宿主在调用前自行处理。 */
  runTurn(userText: string): Promise<void>;
}

/** 本轮被用户终止时的最终文案。 */
export const ABORTED_TURN_TEXT = '已终止本轮对话（未完成）。';

export function createChatController(deps: ChatControllerDeps): ChatController {
  const onLog: LlmLogFn = deps.onLog ?? (() => {});
  let history: ChatMessage[] = [];
  let busy = false;
  let abortController: AbortController | null = null;

  return {
    isBusy: () => busy,

    abort() {
      if (busy) {
        abortController?.abort();
        onLog('info', 'turn_abort_requested');
      }
    },

    getHistory: () => history,

    clearHistory() {
      history = [];
    },

    async runTurn(userText: string): Promise<void> {
      if (busy) return;

      const config = deps.getLlmConfig();
      if (config.apiKey.length === 0) {
        deps.onMissingApiKey();
        return;
      }
      // apiPath 显式清空（空串）不回退默认路径：交由宿主引导配置
      if (config.apiPath !== undefined && config.apiPath.trim().length === 0) {
        deps.onMissingApiPath();
        return;
      }

      busy = true;
      deps.onBusyChange?.(true);
      deps.onUserMessage(userText);
      deps.onTurnStart?.();
      onLog('info', 'turn_start', userText);
      const view = deps.createTurnView();
      abortController = new AbortController();
      const signal = abortController.signal;

      try {
        // 每轮发送前刷新工具清单，保证页面工具变化（listChanged）能被感知
        const tools: AgentTool[] = await deps.getTools();
        const llm = deps.createLlm
          ? deps.createLlm(config)
          : createLlmClient(config, fetch, onLog);
        // 历史裁剪：保留最近 maxHistoryTurns 轮（0 = 不裁剪），随 transcript 收敛逐轮有界
        const boundedHistory = trimHistory(history, deps.getMaxHistoryTurns());
        const loopOptions: AgentLoopOptions = {
          onEvent: (event) => view.onEvent(event),
          signal,
        };
        // 空串归一化：agent-loop 的 ?? 回退仅对 undefined/null 生效
        const trimmedPrompt = deps.getSystemPrompt().trim();
        if (trimmedPrompt) loopOptions.systemPrompt = trimmedPrompt;
        const result = await runAgentLoop(
          // 历史以本轮用户消息结尾（agent-loop 约定）
          [...boundedHistory, { role: 'user' as const, content: userText }],
          tools,
          {
            llm,
            executeTool: (name, args) => deps.callTool(name, args),
          },
          loopOptions
        );
        view.setText(result.text);
        history = result.transcript;
        onLog('info', 'turn_end', result.text);
      } catch (error) {
        if (error instanceof AgentAbortError || signal.aborted) {
          view.setText(ABORTED_TURN_TEXT);
          onLog('info', 'turn_aborted');
        } else {
          const message = error instanceof Error ? error.message : String(error);
          view.setText(`出错了：${message}`);
          onLog('error', 'turn_error', message);
        }
      } finally {
        deps.onTurnSettled?.();
        busy = false;
        deps.onBusyChange?.(false);
        abortController = null;
      }
    },
  };
}

/** re-export：宿主需要的 API_PATH_EMPTY_HINT（onMissingApiPath 提示语）。 */
export { API_PATH_EMPTY_HINT };
