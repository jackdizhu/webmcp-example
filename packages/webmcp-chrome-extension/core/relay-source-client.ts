// relay 浏览器源客户端：让本扩展的 service worker 以「浏览器源」身份直连本机
// webmcp-extension-relay（ws://127.0.0.1:9333-9348），替代上游 embed.js + widget iframe 方案，
// 页面端零侵入。协议语义逐条对照上游
// git-source/npm-packages/packages/webmcp-local-relay/src/browser/widgetRuntime.ts：
//   发现（discovery 子协议探测 + 1.2s server-hello 超时）→ hello 握手（1s ACK 超时）→
//   tools/list 初始同步 → invoke/result 转发 → ping/pong → reload 自愈；
//   断线恢复：500ms(±15%) 同端点重试 → 10/20/30s 全范围重扫 → dormant（2min 心跳探测 + wake() 唤醒）。
//
// 设计约束：
// - 不依赖上游 npm 包（其 schemas 依赖 Node 侧 SDK，摇树进 SW 产物不划算），消息类型手写，
//   字段与上游 schemas.ts 严格对齐；
// - WebSocket 工厂、端点缓存、reload 回调均可注入，保证 SW 外可单测（jsdom 无真实 WS）。
import type { PageToolMeta } from './page-tools-bridge';
import { queryLoopbackPermission, type LnaPermissionQuerier, type LnaPermissionState } from './relay-lna-permission';

/** relay 浏览器协议子协议（上游 shared.ts RELAY_BROWSER_PROTOCOL）。 */
export const RELAY_BROWSER_PROTOCOL = 'webmcp.v1';
/** relay 发现协议子协议（上游 shared.ts RELAY_DISCOVERY_PROTOCOL）。 */
export const RELAY_DISCOVERY_PROTOCOL = 'webmcp-discovery.v1';
/** relay 默认端口段（上游 shared.ts：9333–9348，与服务端 portStrategy 一致）。 */
export const RELAY_PORT_RANGE_START = 9333;
export const RELAY_PORT_RANGE_END = 9348;

/** 探测候选端点的 server-hello 等待超时（上游 RELAY_SERVER_HELLO_TIMEOUT_MS）。 */
const PROBE_TIMEOUT_MS = 1_200;
/** hello 握手 ACK 超时（上游 RELAY_HELLO_TIMEOUT_MS）。 */
const HELLO_ACK_TIMEOUT_MS = 1_000;
/** 同端点断线重试基础延迟（上游 RECONNECT_DELAY_MS，±15% 抖动）。 */
const RECONNECT_DELAY_MS = 500;
/** 全范围重扫延迟序列（上游 REDISCOVERY_DELAYS_MS），耗尽后进入 dormant。 */
const REDISCOVERY_DELAYS_MS = [10_000, 20_000, 30_000];
/** dormant 心跳探测间隔（上游 DORMANT_HEARTBEAT_INTERVAL_MS）。 */
const DORMANT_HEARTBEAT_INTERVAL_MS = 120_000;
/** 单次工具调用超时：超时后向 relay 回 isError result，避免 MCP Client 悬挂。 */
const INVOKE_TIMEOUT_MS = 60_000;
/**
 * hello 接受后的延迟重推序列：初始快照在握手时取一次，可能早于页面的工具注册
 * （SPA 慢加载 / 反爬挑战页延迟），且 toolsChanged 推送链任何一环丢失都会让
 * registry 停留在 0 工具旧快照 —— 有限次重推作为对账兜底。
 */
const INITIAL_RESYNC_DELAYS_MS = [2_000, 5_000, 10_000];
/** tools/changed 推送失败后的单次重试延迟（仅重试一次，避免失败风暴）。 */
const PUSH_RETRY_DELAY_MS = 1_500;

/** relay → 浏览器源握手问候（上游 ServerHelloMessage）。 */
export interface RelayServerHello {
  type: 'server-hello';
  service: 'webmcp-extension-relay';
  version: 1;
  host: string;
  instanceId: string;
  port: number;
  label?: string;
  relayId?: string;
  workspace?: string;
}

/** 浏览器源元数据（对应上游 BrowserHelloMessage 字段）。 */
export interface RelaySourceMeta {
  /** 稳定源标识：扩展方案用真实 Chrome tabId。 */
  tabId: string;
  origin?: string;
  url?: string;
  title?: string;
}

/** 转发给 relay 的工具描述（与上游 tools/list 载荷对齐）。 */
export interface RelayToolDescriptor extends PageToolMeta {
  title?: string;
  annotations?: unknown;
}

/**
 * 页面工具门面：RelaySourceClient 借此读写页面工具，与 relay 无关。
 * 扩展方案中由 tab-source-manager 基于 chrome.tabs.connect + page-tools 桥接协议实现。
 */
export interface RelayToolsFacade {
  listTools(): Promise<RelayToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 页面工具清单变化通知（page-tools 桥接 toolsChanged 推送），返回取消订阅函数。 */
  onToolsChanged(listener: () => void): () => void;
}

/** 已命中并可复用的 relay 端点。 */
export interface RelayEndpoint {
  host: string;
  port: number;
}

/** 单个源客户端的连接状态。 */
export type RelayConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'dormant' | 'stopped';

/** 连接状态快照（供编排层聚合后展示 / 调试）。 */
export interface RelayConnectionStatus {
  state: RelayConnectionState;
  /** 当前命中的 relay 端点（未连接时为 null）。 */
  endpoint: RelayEndpoint | null;
  /** 已同步到 relay 的工具数量。 */
  toolsCount: number;
  /** 人类可读的补充说明（如重连延迟、拒绝原因）。 */
  detail?: string;
  /** 状态产生时间（Date.now()）。 */
  updatedAt: number;
  /**
   * Chrome LNA（本地网络访问）拦截标记：dormant 且 loopback 权限非 granted 时
   * 为 true（chrome-extension:// SW 对 loopback WebSocket 的请求被 Chrome
   * 静默拦截，见 relay-lna-permission.ts）。侧栏据此展示修复引导。
   */
  lnaBlocked?: boolean;
}

/** 可注入的 WebSocket 最小面（生产传全局 WebSocket，测试传桩）。 */
export interface RelaySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  addEventListener(type: 'close' | 'error', listener: (event: unknown) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  removeEventListener(type: 'close' | 'error', listener: (event: unknown) => void): void;
}

export interface RelaySourceClientOptions {
  /** 源元数据（真实 tabId / 页面 origin / url / title）。 */
  source: RelaySourceMeta;
  /** 页面工具门面。 */
  facade: RelayToolsFacade;
  /** WebSocket 工厂（默认全局 WebSocket；测试注入桩）。 */
  socketFactory?: (url: string, protocols: string[]) => RelaySocket;
  /** relay 主机提示，仅允许 loopback（对照 widget 的 isLoopbackHost 守卫）。 */
  hostHint?: string;
  /** relay 优先端口提示（默认 9333，仅是发现起点而非硬绑定）。 */
  portHint?: number;
  /** 端点缓存注入（默认不缓存；SW 方案可接 chrome.storage）。 */
  readCachedEndpoint?: () => RelayEndpoint | null;
  writeCachedEndpoint?: (endpoint: RelayEndpoint) => void;
  clearCachedEndpoint?: () => void;
  /** relay 下发 reload 时的自愈回调（扩展方案：chrome.tabs.reload(tabId)）。 */
  onReload?: () => void;
  /** 单次工具调用超时（默认 60_000ms；超时向 relay 回 isError result）。 */
  invokeTimeoutMs?: number;
  /** 自动开始发现连接（默认 true）。 */
  autoConnect?: boolean;
  /**
   * 连接状态变化回调（每次状态迁移触发；连接存活期间 tools 数量变化也会触发，
   * state 不变）。SW 编排层借此聚合展示到侧栏。
   */
  onStatusChange?: (status: RelayConnectionStatus) => void;
  /**
   * 调试日志开关（默认 true）：探测候选、握手、状态迁移等打印到控制台，
   * 用于跟进连接过程。关键错误（hello 被拒、调用失败）无论开关都会打印。
   */
  debugLog?: boolean;
  /** LNA 权限查询注入（默认 queryLoopbackPermission；测试注入桩）。 */
  queryLoopbackPermission?: LnaPermissionQuerier;
}

type RelayRuntimePhase = 'idle' | 'discovering' | 'dormant';

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** SW 控制台统一日志前缀（DevTools 过滤框输入即可筛出全部 relay 连接日志）。 */
const LOG_PREFIX = '[webmcp-relay-source]';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 按级别打印日志；debug/info 级别受 debugLog 开关控制，warn/error 始终打印。 */
function relayLog(level: LogLevel, debugEnabled: boolean, tabId: string, args: unknown[]): void {
  const payload = [`${LOG_PREFIX}[tab ${tabId}]`, ...args];
  if (level === 'debug' || level === 'info') {
    if (debugEnabled) {
      if (level === 'debug') console.debug(...payload);
      else console.info(...payload);
    }
    return;
  }
  if (level === 'warn') console.warn(...payload);
  else console.error(...payload);
}

function safeSend(socket: RelaySocket, data: string): void {
  try {
    if (socket.readyState === 1) {
      socket.send(data);
    }
  } catch (error) {
    console.warn('[webmcp-relay-source] Failed to send message:', error);
  }
}

/** 工具名列表的日志摘要：空列表显式标注（0 工具是「源被 relay 隐藏」的关键诊断信号）。 */
function toolNamesSummary(tools: RelayToolDescriptor[]): string {
  if (tools.length === 0) {
    return '0 个工具（页面尚未注册任何 WebMCP 工具，relay 的 list_sources 不会显示该源）';
  }
  return `${String(tools.length)} 个: ${tools.map((tool) => tool.name).join(', ')}`;
}

/** invoke 参数的日志摘要（截断，避免大参数刷屏）。 */
function summarizeArgs(args: Record<string, unknown>, max = 200): string {
  try {
    const text = JSON.stringify(args) ?? '{}';
    return text.length > max ? `${text.slice(0, max)}…(+${String(text.length - max)})` : text;
  } catch {
    return '<unserializable args>';
  }
}

/** 解析 server-hello（字段校验对照上游 parseRelayHello）。 */
function parseServerHello(value: unknown): RelayServerHello | null {
  if (!isJsonObject(value) || value['type'] !== 'server-hello') {
    return null;
  }
  if (
    value['service'] !== 'webmcp-extension-relay' ||
    value['version'] !== 1 ||
    typeof value['host'] !== 'string' ||
    typeof value['instanceId'] !== 'string' ||
    typeof value['port'] !== 'number'
  ) {
    return null;
  }
  return {
    type: 'server-hello',
    service: 'webmcp-extension-relay',
    version: 1,
    host: value['host'],
    instanceId: value['instanceId'],
    port: value['port'],
  };
}

/** IPv6 裸地址补方括号（ws://::1:9333 不可解析，对照上游处理）。 */
function toUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * 单个浏览器源到 relay 的连接客户端。
 *
 * 生命周期：start() 触发端口发现与握手；连接存活期间转发工具清单与调用；
 * 断线后自动按 widgetRuntime 同款状态机恢复（重试 → 重扫 → dormant）。
 */
export class RelaySourceClient {
  private readonly source: RelaySourceMeta;
  private readonly facade: RelayToolsFacade;
  private readonly socketFactory: (url: string, protocols: string[]) => RelaySocket;
  private readonly hostHint: string;
  private readonly portHint: number;
  private readonly readCachedEndpoint: (() => RelayEndpoint | null) | undefined;
  private readonly writeCachedEndpoint: ((endpoint: RelayEndpoint) => void) | undefined;
  private readonly clearCachedEndpoint: (() => void) | undefined;
  private readonly onReload: (() => void) | undefined;
  private readonly invokeTimeoutMs: number;
  private readonly debugLog: boolean;
  private readonly queryLoopbackPermissionFn: LnaPermissionQuerier;

  private phase: RelayRuntimePhase = 'idle';
  private activeSocket: RelaySocket | null = null;
  private activeEndpoint: RelayEndpoint | null = null;
  private discoveryCycleCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dormantHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeToolsChanged: (() => void) | null = null;
  private stopped = false;
  /** dormant 期间检测到的 LNA 拦截标记（连接成功或主动唤醒时复位）。 */
  private lnaBlocked = false;
  /** hello 接受后的延迟重推定时器（连接断开或 stop 时清理）。 */
  private resyncTimers: ReturnType<typeof setTimeout>[] = [];
  /** tools/changed 推送失败的重试定时器（单次）。 */
  private pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly statusListeners = new Set<(status: RelayConnectionStatus) => void>();
  /** 最近一次发射的状态（toolsCount 增量更新时复用 state/endpoint）。 */
  private lastStatus: RelayConnectionStatus | null = null;
  private toolsCount = 0;

  constructor(options: RelaySourceClientOptions) {
    const hostHint = options.hostHint ?? '127.0.0.1';
    if (!isLoopbackHost(hostHint)) {
      throw new Error(`relay host must be a loopback address, got: ${hostHint}`);
    }
    this.source = options.source;
    this.facade = options.facade;
    this.socketFactory =
      options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as RelaySocket);
    this.hostHint = hostHint;
    this.portHint = options.portHint ?? RELAY_PORT_RANGE_START;
    this.readCachedEndpoint = options.readCachedEndpoint;
    this.writeCachedEndpoint = options.writeCachedEndpoint;
    this.clearCachedEndpoint = options.clearCachedEndpoint;
    this.onReload = options.onReload;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? INVOKE_TIMEOUT_MS;
    this.debugLog = options.debugLog ?? true;
    this.queryLoopbackPermissionFn = options.queryLoopbackPermission ?? queryLoopbackPermission;
    if (options.onStatusChange) {
      this.statusListeners.add(options.onStatusChange);
    }

    if (options.autoConnect !== false) {
      void this.start();
    }
  }

  /** 订阅连接状态变化（返回取消订阅函数）。 */
  onStatus(listener: (status: RelayConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    if (this.lastStatus) {
      listener(this.lastStatus);
    }
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** 发射状态快照：state/detail 变化或 toolsCount 增量更新时调用。 */
  private emitStatus(state: RelayConnectionState, detail?: string): void {
    this.lastStatus = {
      state,
      endpoint: this.activeEndpoint ? { ...this.activeEndpoint } : null,
      toolsCount: this.toolsCount,
      updatedAt: Date.now(),
      // exactOptionalPropertyTypes：仅在拦截时写入，避免显式 undefined
      ...(this.lnaBlocked ? { lnaBlocked: true } : {}),
    };
    if (detail !== undefined) {
      this.lastStatus.detail = detail;
    }
    for (const listener of this.statusListeners) {
      try {
        listener(this.lastStatus);
      } catch (error) {
        relayLog('warn', this.debugLog, this.source.tabId, ['status listener threw:', error]);
      }
    }
    relayLog(
      'info',
      this.debugLog,
      this.source.tabId,
      [`state → ${state}`, this.activeEndpoint ? `${this.activeEndpoint.host}:${String(this.activeEndpoint.port)}` : 'no endpoint', detail ?? '', `tools=${String(this.toolsCount)}`]
    );
  }

  /** 增量更新工具数量并重发当前状态（连接存活期间工具清单变化）。 */
  private emitToolsCount(count: number): void {
    if (this.toolsCount === count && this.lastStatus !== null) {
      return;
    }
    this.toolsCount = count;
    if (this.lastStatus) {
      this.emitStatus(this.lastStatus.state, this.lastStatus.detail);
    }
  }

  /** 启动端口发现与握手（幂等：仅 idle 状态触发）。 */
  start(): void {
    if (this.phase !== 'idle' || this.activeSocket) {
      return;
    }
    relayLog('info', this.debugLog, this.source.tabId, ['start: begin relay discovery']);
    this.emitStatus('connecting', 'starting discovery');
    void this.discoverRelay().then((connected) => {
      if (!connected && !this.stopped) {
        this.scheduleRediscovery();
      }
    });
  }

  /** dormant 唤醒：清理休眠态并立即全范围重扫（页面重新可见等场景）。 */
  wake(): void {
    if (this.phase !== 'dormant' || this.stopped) {
      return;
    }
    relayLog('info', this.debugLog, this.source.tabId, ['wake: dormant → rediscovery']);
    this.cleanupDormant();
    this.discoveryCycleCount = 0;
    this.lnaBlocked = false;
    this.emitStatus('connecting', 'waking from dormant');
    void this.discoverRelay().then((connected) => {
      if (!connected && !this.stopped) {
        this.enterDormant();
      }
    });
  }

  /** 是否处于休眠态（供编排层决定是否需要唤醒）。 */
  isDormant(): boolean {
    return this.phase === 'dormant';
  }

  /** 停止并释放全部资源（SW 编排层在标签页关闭/导航时调用）。 */
  stop(): void {
    relayLog('info', this.debugLog, this.source.tabId, ['stop: releasing client']);
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearHelloAckTimer();
    this.clearResyncTimers();
    this.clearPushRetryTimer();
    this.cleanupDormant();
    this.unsubscribeToolsChanged?.();
    this.unsubscribeToolsChanged = null;
    const socket = this.activeSocket;
    this.activeSocket = null;
    this.activeEndpoint = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // 关闭失败忽略：socket 可能已断开
      }
    }
    this.emitStatus('stopped');
  }

  /** 更新源元数据（页面标题变化等场景），下次握手生效。 */
  updateSource(patch: Partial<RelaySourceMeta>): void {
    Object.assign(this.source, patch);
  }

  // ---- 发现与握手 ----

  private buildDiscoveryCandidates(): RelayEndpoint[] {
    const seen = new Set<string>();
    const candidates: RelayEndpoint[] = [];
    const push = (host: string, port: number): void => {
      const key = `${host}:${String(port)}`;
      if (seen.has(key) || !Number.isInteger(port) || port < 1 || port > 65535) {
        return;
      }
      seen.add(key);
      candidates.push({ host, port });
    };

    push(this.hostHint, this.portHint);
    const cached = this.readCachedEndpoint?.() ?? null;
    if (cached) {
      push(cached.host, cached.port);
    }
    for (const host of ['127.0.0.1', '[::1]']) {
      for (let port = RELAY_PORT_RANGE_START; port <= RELAY_PORT_RANGE_END; port += 1) {
        push(host, port);
      }
    }
    return candidates;
  }

  /** 探测候选端点：1.2s 内收到合法 server-hello 才算命中。 */
  private probeEndpoint(candidate: RelayEndpoint): Promise<{
    socket: RelaySocket;
    hello: RelayServerHello;
  } | null> {
    const url = `ws://${toUrlHost(candidate.host)}:${String(candidate.port)}`;
    const probeStart = Date.now();
    relayLog('debug', this.debugLog, this.source.tabId, [`probe ${url}`]);
    return new Promise((resolve) => {
      let settled = false;
      let socket: RelaySocket;
      try {
        socket = this.socketFactory(url, [RELAY_DISCOVERY_PROTOCOL, RELAY_BROWSER_PROTOCOL]);
      } catch {
        resolve(null);
        return;
      }

      const settle = (result: { socket: RelaySocket; hello: RelayServerHello } | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        if (result === null) {
          try {
            socket.close();
          } catch {
            // 探测失败路径，关闭异常忽略
          }
        }
        resolve(result);
      };

      const onMessage = (event: { data: unknown }): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const hello = parseServerHello(parsed);
        if (hello) {
          relayLog(
            'debug',
            this.debugLog,
            this.source.tabId,
            [`probe ${url} hit in ${String(Date.now() - probeStart)}ms`, `instance=${hello.instanceId}`]
          );
          settle({ socket, hello });
        }
      };
      const onFail = (): void => {
        relayLog('debug', this.debugLog, this.source.tabId, [`probe ${url} failed after ${String(Date.now() - probeStart)}ms`]);
        settle(null);
      };

      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onFail);
      socket.addEventListener('error', onFail);

      const timeoutId = setTimeout(() => {
        settle(null);
      }, PROBE_TIMEOUT_MS);
    });
  }

  private async discoverRelay(): Promise<boolean> {
    this.phase = 'discovering';
    const candidates = this.buildDiscoveryCandidates();
    relayLog(
      'debug',
      this.debugLog,
      this.source.tabId,
      [`discovery: ${String(candidates.length)} candidate(s)`, `cycle=${String(this.discoveryCycleCount)}`]
    );
    try {
      for (const candidate of candidates) {
        const probed = await this.probeEndpoint(candidate);
        if (this.stopped) {
          probed?.socket.close();
          return false;
        }
        if (!probed) {
          continue;
        }
        this.activateSocket(probed.socket, candidate);
        return true;
      }
      relayLog('info', this.debugLog, this.source.tabId, ['discovery: no relay found in scan range']);
      return false;
    } finally {
      if (this.phase === 'discovering') {
        this.phase = 'idle';
      }
    }
  }

  /** 激活已命中的连接：注册消息处理并执行两段式握手。 */
  private activateSocket(socket: RelaySocket, endpoint: RelayEndpoint): void {
    this.activeSocket = socket;
    this.activeEndpoint = endpoint;
    this.discoveryCycleCount = 0;
    this.phase = 'idle';
    this.lnaBlocked = false;
    this.emitStatus('connecting', `handshaking ${endpoint.host}:${String(endpoint.port)}`);

    socket.addEventListener('message', (event) => this.handleRelayMessage(socket, event));
    socket.addEventListener('close', () => {
      if (this.activeSocket !== socket || this.stopped) {
        return;
      }
      relayLog('warn', this.debugLog, this.source.tabId, [
        `connection closed by relay (${endpoint.host}:${String(endpoint.port)})`,
      ]);
      // 先留档端点再清空：scheduleRetrySameEndpoint 依赖端点做同端点重试
      const lastEndpoint = this.activeEndpoint ? { ...this.activeEndpoint } : null;
      this.activeSocket = null;
      this.activeEndpoint = null;
      this.helloAccepted = false;
      // 连接已死：待执行的重推/重试全部作废
      this.clearResyncTimers();
      this.clearPushRetryTimer();
      this.scheduleRetrySameEndpoint(lastEndpoint);
    });
    socket.addEventListener('error', () => {
      relayLog('warn', this.debugLog, this.source.tabId, ['socket error']);
      try {
        socket.close();
      } catch {
        // 错误路径关闭异常忽略
      }
    });

    // 握手前先取初始工具清单：relay 接受 hello 后立即注册动态工具
    this.facade
      .listTools()
      .then((tools) => {
        if (this.activeSocket !== socket || this.stopped) {
          return;
        }
        relayLog('debug', this.debugLog, this.source.tabId, [`hello: sending with ${String(tools.length)} initial tool(s)`]);
        safeSend(
          socket,
          JSON.stringify({
            type: 'hello',
            tabId: this.source.tabId,
            origin: this.source.origin,
            url: this.source.url,
            title: this.source.title,
          })
        );
        // 记住初始工具清单，ACK 后发送 tools/list
        this.pendingInitialTools = tools;
        this.helloAckTimer = setTimeout(() => {
          this.helloAckTimer = null;
          if (this.activeSocket !== socket || socket.readyState !== 1 || this.helloAccepted) {
            return;
          }
          console.warn('[webmcp-relay-source] Relay did not acknowledge browser hello');
          socket.close(4000, 'Browser hello was not acknowledged');
        }, HELLO_ACK_TIMEOUT_MS);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // 高频归因：Port 断连（页面在扩展重载前已打开，content script 失效）
        const hint = /disconnected|receiving end/i.test(message)
          ? '（页面侧 content script 失效——扩展重载后请刷新页面再试）'
          : '';
        relayLog('warn', true, this.source.tabId, [`Hello handshake failed: ${message}`, hint]);
        try {
          socket.close();
        } catch {
          // 握手失败路径关闭异常忽略
        }
      });

    // 工具清单变化 → tools/changed（连接被 relay 接受后才转发）；重连时先退订旧门面订阅
    this.unsubscribeToolsChanged?.();
    this.unsubscribeToolsChanged = this.facade.onToolsChanged(() => {
      void this.pushToolsChanged();
    });
  }

  private pendingInitialTools: RelayToolDescriptor[] = [];
  private helloAckTimer: ReturnType<typeof setTimeout> | null = null;
  private helloAccepted = false;

  private async pushToolsChanged(isRetry = false): Promise<void> {
    const socket = this.activeSocket;
    if (!socket || !this.helloAccepted) {
      return;
    }
    try {
      const tools = await this.facade.listTools();
      relayLog('info', this.debugLog, this.source.tabId, [`tools/changed: pushing ${toolNamesSummary(tools)}`]);
      this.emitToolsCount(tools.length);
      safeSend(socket, JSON.stringify({ type: 'tools/changed', tools }));
      // 推送成功：待重试已无意义（本次推送就是最新快照）
      this.clearPushRetryTimer();
    } catch (error) {
      console.warn('[webmcp-relay-source] Failed to push tools/changed:', error);
      // 仅非重试路径调度一次重试，避免持续性失败演变为重试风暴
      if (!isRetry) {
        this.schedulePushRetry(socket);
      }
    }
  }

  /** 推送失败后的单次重试（短退避）；重试仍失败则等待下一次 toolsChanged 或重连。 */
  private schedulePushRetry(socket: RelaySocket): void {
    if (this.stopped || this.pushRetryTimer) {
      return;
    }
    this.pushRetryTimer = setTimeout(() => {
      this.pushRetryTimer = null;
      if (this.activeSocket !== socket || this.stopped || !this.helloAccepted) {
        return;
      }
      relayLog('info', this.debugLog, this.source.tabId, ['retrying tools/changed push']);
      void this.pushToolsChanged(true);
    }, PUSH_RETRY_DELAY_MS);
  }

  private clearPushRetryTimer(): void {
    if (this.pushRetryTimer) {
      clearTimeout(this.pushRetryTimer);
      this.pushRetryTimer = null;
    }
  }

  /** 握手成功后的有限次延迟重推：覆盖页面晚注册工具与 toolsChanged 链路丢事件。 */
  private scheduleInitialResync(socket: RelaySocket): void {
    this.clearResyncTimers();
    for (const delay of INITIAL_RESYNC_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.resyncTimers = this.resyncTimers.filter((entry) => entry !== timer);
        if (this.activeSocket !== socket || this.stopped || !this.helloAccepted) {
          return;
        }
        relayLog('debug', this.debugLog, this.source.tabId, [`resync push after ${String(delay)}ms`]);
        void this.pushToolsChanged();
      }, delay);
      this.resyncTimers.push(timer);
    }
  }

  private clearResyncTimers(): void {
    for (const timer of this.resyncTimers) {
      clearTimeout(timer);
    }
    this.resyncTimers = [];
  }

  // ---- 运行期消息 ----

  private handleRelayMessage(socket: RelaySocket, event: { data: unknown }): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch (error) {
      console.warn('[webmcp-relay-source] Failed to parse relay message:', error);
      return;
    }
    if (!isJsonObject(parsed) || typeof parsed['type'] !== 'string') {
      return;
    }

    // 探测期间收到的 server-hello 已在 probeEndpoint 处理；此处忽略重复问候
    if (parsed['type'] === 'server-hello') {
      return;
    }

    if (parsed['type'] === 'hello/accepted') {
      this.clearHelloAckTimer();
      this.helloAccepted = true;
      this.writeCachedEndpoint?.(this.activeEndpoint ?? { host: '', port: 0 });
      relayLog(
        'info',
        this.debugLog,
        this.source.tabId,
        [
          `hello accepted by relay (${this.activeEndpoint ? `${this.activeEndpoint.host}:${String(this.activeEndpoint.port)}` : 'unknown'}), pushing ${toolNamesSummary(this.pendingInitialTools)}`,
        ]
      );
      this.emitToolsCount(this.pendingInitialTools.length);
      this.emitStatus('connected');
      safeSend(socket, JSON.stringify({ type: 'tools/list', tools: this.pendingInitialTools }));
      this.pendingInitialTools = [];
      // 初始快照可能早于页面工具注册，安排有限次延迟重推对账
      this.scheduleInitialResync(socket);
      return;
    }

    if (parsed['type'] === 'hello/rejected') {
      this.clearHelloAckTimer();
      this.helloAccepted = false;
      this.clearCachedEndpoint?.();
      const reason = String(parsed['reason'] ?? '');
      const message = String(parsed['message'] ?? '');
      console.error(
        '[webmcp-relay-source] Relay rejected browser hello:',
        reason,
        message
      );
      this.emitStatus('reconnecting', `hello rejected: ${reason || message || 'unknown reason'}`);
      try {
        socket.close(1008, String(parsed['message'] ?? 'Host origin not allowed'));
      } catch {
        // 结构化拒绝后关闭异常忽略
      }
      return;
    }

    if (parsed['type'] === 'ping') {
      relayLog('debug', this.debugLog, this.source.tabId, ['ping → pong']);
      safeSend(socket, JSON.stringify({ type: 'pong' }));
      return;
    }

    if (parsed['type'] === 'reload') {
      relayLog('info', this.debugLog, this.source.tabId, ['reload requested by relay']);
      this.onReload?.();
      return;
    }

    if (parsed['type'] === 'invoke') {
      void this.handleInvoke(socket, parsed);
      return;
    }

    console.debug(
      `[webmcp-relay-source] Ignoring unrecognized message type: ${String(parsed['type']).replace(/[\r\n]/g, '')}`
    );
  }

  private async handleInvoke(socket: RelaySocket, message: Record<string, unknown>): Promise<void> {
    const callId = typeof message['callId'] === 'string' ? message['callId'] : '';
    const toolName = typeof message['toolName'] === 'string' ? message['toolName'] : '';
    const args = isJsonObject(message['args']) ? message['args'] : {};

    const sendResult = (result: unknown): void => {
      safeSend(socket, JSON.stringify({ type: 'result', callId, result }));
    };
    const errorResult = (text: string): unknown => ({
      isError: true,
      content: [{ type: 'text', text }],
    });

    if (!callId) {
      return;
    }
    const invokeStart = Date.now();
    relayLog('info', this.debugLog, this.source.tabId, [`invoke → ${toolName} args=${summarizeArgs(args)}`]);

    try {
      const result = await Promise.race([
        this.facade.callTool(toolName, args),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Host response timeout: invoke ${toolName}`)), this.invokeTimeoutMs);
        }),
      ]);
      relayLog(
        'info',
        this.debugLog,
        this.source.tabId,
        [`invoke ← ${toolName} ok in ${String(Date.now() - invokeStart)}ms`]
      );
      sendResult(result);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      relayLog('warn', true, this.source.tabId, [`invoke ← ${toolName} FAILED in ${String(Date.now() - invokeStart)}ms:`, text]);
      sendResult(errorResult(text));
    }
  }

  private clearHelloAckTimer(): void {
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer);
      this.helloAckTimer = null;
    }
  }

  // ---- 断线恢复状态机（对照 widgetRuntime）----

  private scheduleRetrySameEndpoint(endpoint: RelayEndpoint | null): void {
    if (this.stopped || !endpoint || this.retryTimer) {
      return;
    }
    // 拷贝一份端点快照：延迟回调期间编排层可能继续改写状态
    const target = { ...endpoint };
    // ±15% 抖动，避免多 tab 同时断线时的重连风暴
    const delay = Math.round(RECONNECT_DELAY_MS * (0.85 + Math.random() * 0.3));
    relayLog('info', this.debugLog, this.source.tabId, [
      `reconnect: retry same endpoint ${endpoint.host}:${String(endpoint.port)} in ~${String(delay)}ms`,
    ]);
    this.emitStatus('reconnecting', `retry ${endpoint.host}:${String(endpoint.port)} in ~${String(delay)}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectToEndpoint(target).then((connected) => {
        if (!connected) {
          this.scheduleRediscovery();
        }
      });
    }, delay);
  }

  private scheduleRediscovery(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    const delay = REDISCOVERY_DELAYS_MS[this.discoveryCycleCount];
    if (delay === undefined) {
      relayLog('warn', true, this.source.tabId, ['rediscovery exhausted → dormant']);
      this.enterDormant();
      return;
    }
    relayLog('info', this.debugLog, this.source.tabId, [
      `rediscovery: full scan in ${String(delay)}ms (cycle ${String(this.discoveryCycleCount + 1)})`,
    ]);
    this.emitStatus('reconnecting', `full rescan in ${String(delay)}ms (cycle ${String(this.discoveryCycleCount + 1)})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.discoverRelay().then((connected) => {
        if (!connected && !this.stopped) {
          this.discoveryCycleCount += 1;
          this.scheduleRediscovery();
        }
      });
    }, delay);
  }

  private async connectToEndpoint(endpoint: RelayEndpoint): Promise<boolean> {
    const probed = await this.probeEndpoint(endpoint);
    if (this.stopped) {
      probed?.socket.close();
      return false;
    }
    if (!probed) {
      return false;
    }
    this.activateSocket(probed.socket, endpoint);
    return true;
  }

  private enterDormant(): void {
    if (this.phase === 'dormant' || this.stopped) {
      return;
    }
    this.phase = 'dormant';
    relayLog('info', this.debugLog, this.source.tabId, [
      `dormant: no relay found; probing hint/cached endpoints every ${String(DORMANT_HEARTBEAT_INTERVAL_MS / 1000)}s`,
    ]);
    this.emitStatus('dormant', 'relay not found on this machine');
    void this.checkLnaBlocked();
    this.dormantHeartbeatTimer = setInterval(() => {
      void this.heartbeatProbe();
    }, DORMANT_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * LNA 拦截检测：dormant（探测全失败）时查询 Chrome 本地网络访问权限。
   * chrome-extension:// SW 对 loopback WebSocket 的请求会被 Chrome 142+/147+
   * 静默拦截（ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS），且 SW 无弹窗面，
   * 错误事件不携带原因 —— 唯一可靠的区分手段是 Permissions API 查询权限状态。
   * 非 granted 时在状态详情中给出修复路径（侧栏展示 + 控制台 warn）。
   */
  private async checkLnaBlocked(): Promise<void> {
    if (this.stopped || this.phase !== 'dormant' || this.lnaBlocked) {
      return;
    }
    let state: LnaPermissionState;
    try {
      state = await this.queryLoopbackPermissionFn();
    } catch {
      // 查询本身异常按未支持处理，不阻断状态机
      return;
    }
    // 异步窗口内状态可能已迁移（心跳命中 relay / wake），过期结果直接丢弃
    if (this.stopped || this.phase !== 'dormant') {
      return;
    }
    if (state === 'granted' || state === 'unsupported') {
      return;
    }
    this.lnaBlocked = true;
    const detail =
      state === 'denied'
        ? '已被 Chrome 拦截：本地网络访问权限被拒绝。修复：chrome://extensions → 本扩展「详情」→「网站设置」→ 本地网络访问 = 允许'
        : '疑似被 Chrome 拦截：本地网络访问权限未授予（Service Worker 无法弹窗）。修复：chrome://extensions → 本扩展「详情」→「网站设置」→ 本地网络访问 = 允许';
    console.warn('[webmcp-relay-source] relay 探测全部失败，Chrome 本地网络访问权限状态:', state, '—', detail);
    this.emitStatus('dormant', detail);
  }

  /** dormant 心跳：只探提示端口与缓存端点，不做全范围扫描。 */
  private async heartbeatProbe(): Promise<void> {
    if (this.phase !== 'dormant' || this.stopped) {
      return;
    }
    const seen = new Set<string>();
    const candidates: RelayEndpoint[] = [];
    const push = (host: string, port: number): void => {
      const key = `${host}:${String(port)}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({ host, port });
    };
    push(this.hostHint, this.portHint);
    const cached = this.readCachedEndpoint?.() ?? null;
    if (cached) {
      push(cached.host, cached.port);
    }
    if (candidates.length === 0) {
      return;
    }

    this.phase = 'discovering';
    this.cleanupDormant();
    for (const candidate of candidates) {
      const connected = await this.connectToEndpoint(candidate);
      if (connected) {
        this.discoveryCycleCount = 0;
        return;
      }
    }
    this.enterDormant();
  }

  private cleanupDormant(): void {
    if (this.dormantHeartbeatTimer) {
      clearInterval(this.dormantHeartbeatTimer);
      this.dormantHeartbeatTimer = null;
    }
  }
}
