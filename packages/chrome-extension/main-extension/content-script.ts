import { connectWebMCPClient } from '../core/content-script';
import { startPageToolsBridge, type PageToolsBridgeHandle } from '../core/page-tools-bridge';
import type { Client } from '@modelcontextprotocol/client';

/** 桥接句柄：listChanged 回调在握手期间注册，广播时桥接可能尚未建立，故用可空引用。 */
let bridge: PageToolsBridgeHandle | null = null;

async function waitForDocument(): Promise<void> {
  if (document.readyState !== 'loading') return;
  await new Promise<void>((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

/**
 * MCP 握手有一次性探测缺陷：TabClientTransport.start 只发一次 mcp-check-ready，
 * 若页面侧 MCP 服务此刻未监听，serverReadyPromise 永远 pending（connect 挂死而非失败）。
 * 因此必须带超时 + 有限重试，否则桥接永不注册，侧栏会持续"连接即断"。
 */
const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 1_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function connectWithRetry(): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      // 每次尝试都用全新 Client/Transport：失败或挂死的 Transport 不可复用
      return await withTimeout(
        connectWebMCPClient(
          { name: 'webmcp-extension-main', version: '1.0.0' },
          {
            listChanged: {
              tools: {
                onChanged(error, tools) {
                  if (error || !tools) {
                    console.error('[WebMCP] Failed to refresh page tools:', error);
                    return;
                  }
                  // 页面动态注册/注销工具时向侧栏广播，侧栏订阅后刷新清单展示
                  bridge?.notifyToolsChanged();
                  console.info(
                    '[WebMCP] Page tools updated:',
                    tools.map(({ name }) => name)
                  );
                },
              },
            },
          }
        ),
        CONNECT_TIMEOUT_MS,
        'WebMCP 握手'
      );
    } catch (error) {
      lastError = error;
      console.warn(`[WebMCP] 连接尝试 ${attempt}/${CONNECT_ATTEMPTS} 失败:`, error);
      if (attempt < CONNECT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const client = await connectWithRetry();

  // 握手成功即注册桥接（不等 DOM ready / 初始工具清单），把侧栏可连接窗口最早化。
  // 桥接生命周期与 content script 一致：文档销毁时随上下文一并回收，无需手动停止。
  bridge = startPageToolsBridge(client);

  // Keep this connection alive across BFCache restores; document teardown owns final cleanup.
  await waitForDocument();
  // 初始工具清单仅用于控制台诊断，失败不影响桥接（侧栏会按需拉取）
  try {
    const { tools } = await client.listTools();
    console.info(
      '[WebMCP] Page tools:',
      tools.map(({ name }) => name)
    );
  } catch (error) {
    console.warn('[WebMCP] Initial listTools failed (bridge still active):', error);
  }
}

void main().catch((error) => {
  console.error('[WebMCP] Content-script connection failed:', error);
});
