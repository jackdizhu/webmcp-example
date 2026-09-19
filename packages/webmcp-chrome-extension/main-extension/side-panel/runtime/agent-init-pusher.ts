// 初始化数据推送器（C6 推送路径，探索文档 §5.3 / propose F7）。
//
// 职责：面板侧状态变化（agent 档案 / A2A / 技能 / 工具清单变更）后，把最新初始化
// 载荷推送给「已连接且注册了初始化工具」的页签。与拉取路径（SDK init-request →
// 宿主 handleInitRequest）共用 chat-core buildAgentInitPayload（同 schema 同白名单）。
//
// 触发约定（Q6）：schedule() 由 App 在相关状态变化处调用；500ms 去抖合并高频变更，
// 逐页签过滤 —— 仅向工具清单含 web_mcp_agent_initialization（裸名）的已连接页签推送，
// 每页签载荷按 getInitSnapshot(tabId) 组装（App 侧按页签裁剪 tools）。
// 失败语义：单页签失败仅记录日志、不重试、不影响其他页签（页面可通过拉取路径兜底）。
import {
  AGENT_INITIALIZATION_TOOL_NAME,
  buildAgentInitPayload,
  type AgentInitSnapshot,
  type LlmLogFn,
} from 'webmcp-agent-chat-core';

/** 推送去抖窗口（ms）：合并窗口内的多次 schedule 为一次推送。 */
const PUSH_DEBOUNCE_MS = 500;

/** 推送器依赖（全部为缝函数，便于单测替换）。 */
export interface AgentInitPusherDeps {
  /** 当前已连接页签 id 清单（tab-source-manager.getConnectedTabIds）。 */
  listConnectedTabs: () => number[];
  /** 指定页签暴露的工具裸名清单（panel-client 每页签只读 accessor，Q6 过滤用）。 */
  getTabToolNames: (tabId: number) => Promise<readonly string[]>;
  /** 面板工具执行缝（与手打对话同缝；页面工具名带 tab<id>__ 前缀）。 */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 初始化快照组装缝（与宿主 deps 同一函数，App 注入；按页签裁剪 tools）。 */
  getInitSnapshot: (tabId: number) => Promise<AgentInitSnapshot>;
  /** 日志缝（logEvent，'tasks' 域）。 */
  onLog: LlmLogFn;
}

/**
 * 创建初始化推送器。schedule() 触发一次去抖推送；dispose() 取消挂起的推送。
 * 注意：去抖触发后的 pushAll 为逐页签串行异步执行，本组件不等待其完成。
 */
export function createAgentInitPusher(deps: AgentInitPusherDeps): {
  schedule: () => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const pushToTab = async (tabId: number): Promise<void> => {
    const names = await deps.getTabToolNames(tabId);
    // Q6 过滤：页签未注册初始化工具（未开启智能体反调）则跳过
    if (!names.includes(AGENT_INITIALIZATION_TOOL_NAME)) return;
    const snapshot = await deps.getInitSnapshot(tabId);
    const payload = buildAgentInitPayload(snapshot);
    await deps.callTool(
      `tab${tabId}__${AGENT_INITIALIZATION_TOOL_NAME}`,
      payload as unknown as Record<string, unknown>
    );
    deps.onLog('info', 'agent_init_pushed', { tabId });
  };

  const pushAll = async (): Promise<void> => {
    const tabIds = deps.listConnectedTabs();
    for (const tabId of tabIds) {
      try {
        await pushToTab(tabId);
      } catch (error) {
        // 单页签失败不重试不影响其他页签（页面可经拉取路径兜底）
        deps.onLog('error', 'agent_init_push_failed', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  return {
    schedule: () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void pushAll();
      }, PUSH_DEBOUNCE_MS);
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
