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

  namespace storage {
    namespace local {
      /** Promise 形式自 Chrome 88 起可用（本扩展 minimum_chrome_version 为 116）。 */
      function get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
      function remove(keys: string | string[]): Promise<void>;
    }
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
