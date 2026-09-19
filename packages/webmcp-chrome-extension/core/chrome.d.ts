// 本工程用到的 chrome.* API 的最小环境声明。
//
// 不引入 @types/chrome 的原因：此处仅使用极窄的 API 子集（runtime Port 消息、
// storage.local、sidePanel 行为设置），自持声明可精确描述依赖面，避免为
// 全量 Chrome 类型引入重型开发依赖。新增 API 使用时在此补充对应声明。

declare namespace chrome {
  namespace runtime {
    /** 长连接端口（chrome.runtime.connect / onConnect 的两端句柄）。 */
    interface Port {
      readonly name: string;
      /** 连接发起方信息（onConnect 监听器内可信；接收侧读不到为 undefined）。 */
      readonly sender?: MessageSender;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: {
        addListener(callback: (message: unknown) => void): void;
        removeListener(callback: (message: unknown) => void): void;
      };
      onDisconnect: {
        addListener(callback: (port: Port) => void): void;
        removeListener(callback: (port: Port) => void): void;
      };
    }

    /**
     * 连接发起方信息（onConnect 监听器内可信；SW 反调路由据此注入 sender.tabId/origin）。
     * content script 发起的连接必有 tab 与 origin（http(s)/localhost 来源）。
     */
    interface MessageSender {
      tab?: tabs.Tab;
      origin?: string;
      url?: string;
    }

    /** 上一条 Chrome API 调用的错误；仅在回调/监听器内同步读取有效（读取即视为已消费）。 */
    const lastError: { message: string } | undefined;

    /** 建立到扩展自身的长连接（content script / 扩展页面均在扩展来源内）。 */
    function connect(connectInfo?: { name?: string }): Port;

    /** 监听来自扩展其他上下文的长连接。 */
    const onConnect: {
      addListener(callback: (port: Port) => void): void;
      removeListener(callback: (port: Port) => void): void;
    };

    const onInstalled: {
      addListener(callback: (details: { reason: string }) => void): void;
    };

    /** onMessage 监听器签名：返回 true = sendResponse 异步应答（保持消息通道开放）。 */
    interface OnMessageCallback {
      (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response: unknown) => void
      ): boolean | void;
    }

    /**
     * 一次性消息监听（C7 自检查询：SW 侧接收 CS 的 host-status-query）。
     * 仅声明本工程用到的形态；与其他监听器共存时返回值不阻塞他人应答。
     */
    const onMessage: {
      addListener(callback: OnMessageCallback): void;
      removeListener(callback: OnMessageCallback): void;
    };

    /**
     * 发送一次性消息（C7 自检查询：CS → SW；回调形式，无接收者时回调内 lastError 置位）。
     */
    function sendMessage(message: unknown, responseCallback: (response: unknown) => void): void;

    /**
     * 枚举扩展上下文（C7 面板存活探测：getContexts({contextTypes:['SIDE_PANEL']})，Chrome 116+）。
     */
    function getContexts(options: { contextTypes: Array<'SIDE_PANEL'> }): Promise<Array<{ id?: string }>>;
  }

  namespace tabs {
    /** 标签页信息（本工程使用 id / url / title）。 */
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }

    /** 查询标签页（Promise 形式，Chrome 88+）。 */
    function query(
      queryInfo: { active?: boolean; currentWindow?: boolean; url?: string[] }
    ): Promise<Tab[]>;

    /** 读取单个标签页（Promise 形式，Chrome 88+）。 */
    function get(tabId: number): Promise<Tab>;

    /**
     * 建立到指定标签页 content script 的长连接。
     * 扩展页面 → content script 的标准通道（runtime.connect 到不了 content script）。
     */
    function connect(tabId: number, connectInfo?: { name?: string }): Port;

    /** 重新加载指定标签页（Promise 形式，Chrome 88+）。 */
    function reload(tabId: number): Promise<void>;

    /** 标签页状态/URL/标题变化事件（本工程仅在 status === 'complete' 时使用）。 */
    const onUpdated: {
      addListener(
        callback: (
          tabId: number,
          changeInfo: { status?: string; url?: string; title?: string },
          tab: Tab
        ) => void
      ): void;
      removeListener(
        callback: (
          tabId: number,
          changeInfo: { status?: string; url?: string; title?: string },
          tab: Tab
        ) => void
      ): void;
    };

    /**
     * 向指定页签发送一次性消息（C7 宿主关闭广播：SW → CS host-status-relay）。
     * 回调形式消费 lastError（页签无接收者 = CS 未注入，广播静默丢弃）。
     */
    function sendMessage(
      tabId: number,
      message: unknown,
      responseCallback?: (response: unknown) => void
    ): void;

    /** 标签页关闭事件。 */
    const onRemoved: {
      addListener(callback: (tabId: number) => void): void;
      removeListener(callback: (tabId: number) => void): void;
    };

    /** 活动标签页切换事件。 */
    const onActivated: {
      addListener(callback: (activeInfo: { tabId: number }) => void): void;
      removeListener(callback: (activeInfo: { tabId: number }) => void): void;
    };
  }

  namespace scripting {
    /** executeScript 单帧注入结果（MV3 Promise 形式）。 */
    interface InjectionResult<T = unknown> {
      result?: T;
      frameId?: number;
      error?: { message: string };
    }

    /**
     * 向目标页签注入脚本（需 "scripting" 权限与对应 host_permissions）。
     * func 为序列化执行：函数体不得引用外部标识符，参数经 args 传入。
     */
    function executeScript<T = unknown>(details: {
      target: { tabId: number; allFrames?: boolean };
      func?: (...args: never[]) => T;
      args?: unknown[];
      files?: string[];
      world?: 'MAIN' | 'ISOLATED';
    }): Promise<Array<InjectionResult<T>>>;
  }

  namespace storage {
    namespace local {
      /** Promise 形式自 Chrome 88 起可用（本扩展 minimum_chrome_version 为 116）。 */
      function get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
      function remove(keys: string | string[]): Promise<void>;
    }

    /** 任一 storage 区变化事件（反调白名单缓存即时刷新用）。 */
    const onChanged: {
      addListener(callback: (changes: Record<string, unknown>, areaName: string) => void): void;
      removeListener(callback: (changes: Record<string, unknown>, areaName: string) => void): void;
    };
  }

  namespace sidePanel {
    /** 设置侧边栏行为（Chrome 114+）。 */
    function setPanelBehavior(behavior: { openPanelOnActionClick?: boolean }): Promise<void>;
  }

  namespace downloads {
    /** 下载 Blob/ObjectURL 内容到本机下载目录（需 downloads 权限）。 */
    function download(options: { url: string; filename?: string; saveAs?: boolean }): Promise<number>;
  }
}
