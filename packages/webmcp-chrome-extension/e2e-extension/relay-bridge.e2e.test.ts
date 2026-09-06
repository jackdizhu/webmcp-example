import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageDirectory, '..', '..');
const extensionDirectory = resolve(packageDirectory, 'e2e-extension/dist');
const relayCliPath = resolve(workspaceRoot, 'packages/webmcp-extension-relay/dist/cli.mjs');
// 扩展 SW 的端口发现扫描 9333-9348（widgetRuntime/RelaySourceClient 语义），
// relay 端口必须落在这个区间内才会被自动发现。
const relayPortRangeStart = 9333;
const relayPortRangeEnd = 9348;
const chromiumExecutablePath = process.env.PLAYWRIGHT_EXTENSION_CHROMIUM_EXECUTABLE_PATH;

const pageHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>WebMCP relay bridge fixture</title>
    <script nonce="webmcp-e2e">
      Promise.resolve().then(async () => {
        if (!document.modelContext) throw new Error('document.modelContext was not injected');
        await document.modelContext.registerTool({
          name: 'extension_echo',
          description: 'Echo a value for the relay bridge E2E fixture.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value']
          },
          execute({ value }) {
            return { content: [{ type: 'text', text: 'echo:' + value }] };
          }
        });
        await document.modelContext.registerTool({
          name: 'extension_fail',
          description: 'Fail so the relay can verify MCP error propagation.',
          execute() {
            throw new Error('expected relay failure');
          }
        });
        document.documentElement.dataset.webmcpPageReady = 'true';
      }).catch((error) => {
        document.documentElement.dataset.webmcpPageError = String(error?.message ?? error);
      });
    </script>
  </head>
  <body>WebMCP relay bridge fixture</body>
</html>`;

let server: Server;
let origin: string;

before(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-security-policy':
        "script-src 'nonce-webmcp-e2e'; object-src 'none'; base-uri 'none'",
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(pageHtml);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
});

/**
 * 在扩展的发现区间内找一个空闲端口（先到先得，存在竞态窗口但概率极低）。
 */
async function findFreeRelayPort(): Promise<number> {
  for (let port = relayPortRangeStart; port <= relayPortRangeEnd; port += 1) {
    const free = await new Promise<boolean>((resolvePromise) => {
      const probe = createNetServer();
      probe.once('error', () => resolvePromise(false));
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolvePromise(true));
      });
    });
    if (free) return port;
  }
  throw new Error(`No free relay port in ${relayPortRangeStart}-${relayPortRangeEnd}`);
}

function readText(result: CallToolResult, toolName: string): string {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error(`${toolName} returned no text`);
  return text.text;
}

describe('WebMCP extension <-> relay bridge (e2e)', () => {
  it(
    'exposes page tools to an MCP client through the local relay over stdio',
    { timeout: 120_000 },
    async (t) => {
      if (!existsSync(relayCliPath)) {
        t.skip('relay dist/cli.mjs is missing — run: pnpm --filter webmcp-extension-relay build');
        return;
      }
      const relayVersionCheck = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
      assert.equal(relayVersionCheck.status, 0, 'node runtime unavailable');

      const relayPort = await findFreeRelayPort();

      // 一个 relay 进程、两条传输：stdio（MCP 客户端，即本测试）+ WebSocket（扩展 SW）。
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [relayCliPath, '--port', String(relayPort)],
      });
      const client = new Client({ name: 'webmcp-relay-e2e', version: '0.0.0' });

      const userDataDirectory = mkdtempSync(resolve(tmpdir(), 'webmcp-relay-e2e-'));
      let context: BrowserContext | undefined;
      try {
        await client.connect(transport);

        context = await chromium.launchPersistentContext(userDataDirectory, {
          ...(chromiumExecutablePath
            ? { executablePath: chromiumExecutablePath }
            : { channel: process.env.PLAYWRIGHT_EXTENSION_CHROMIUM_CHANNEL ?? 'chromium' }),
          headless: process.env.PLAYWRIGHT_EXTENSION_HEADLESS !== 'false',
          args: [
            `--disable-extensions-except=${extensionDirectory}`,
            `--load-extension=${extensionDirectory}`,
          ],
        });

        const page = await context.newPage();
        await page.goto(`${origin}/relay`);
        await page.waitForFunction(
          () => {
            const { dataset } = document.documentElement;
            return Boolean(dataset.webmcpPageReady || dataset.webmcpPageError);
          },
          { timeout: 30_000 }
        );
        const pageState = await page.evaluate(() => ({ ...document.documentElement.dataset }));
        assert.equal(
          pageState.webmcpPageError,
          undefined,
          'fixture page failed to register tools'
        );

        // SW（TabSourceManager）发现 relay -> 建立每标签页源 -> 工具同步到 MCP 客户端。
        // content-script 握手 + WS 发现 + 工具聚合有固定耗时，轮询等待。
        const deadline = Date.now() + 45_000;
        let toolNames: string[] = [];
        for (;;) {
          const { tools } = await client.listTools();
          toolNames = tools.map(({ name }) => name);
          if (toolNames.includes('extension_echo')) break;
          if (Date.now() > deadline) {
            assert.fail(
              `extension_echo never reached the MCP client; tools seen: ${toolNames.join(',') || '(none)'}`
            );
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        }

        // 源列表应包含 fixture 标签页。
        const sources = await client.callTool({ name: 'webmcp_list_sources', arguments: {} });
        const sourcesInfo = sources.structuredContent as
          | { count: number; sources: Array<{ url?: string; title?: string }> }
          | undefined;
        assert.ok(sourcesInfo, 'webmcp_list_sources returned no structured content');
        assert.ok(sourcesInfo.count >= 1, 'expected at least one connected source');
        assert.ok(
          sourcesInfo.sources.some((source) => source.url?.startsWith(origin)),
          `fixture tab missing from sources: ${JSON.stringify(sourcesInfo.sources)}`
        );

        // 调用闭环：MCP client -> relay -> 扩展 SW -> 页面 executeTool -> 原路返回。
        const echo = await client.callTool({
          name: 'extension_echo',
          arguments: { value: 'relay-e2e' },
        });
        assert.equal(readText(echo, 'extension_echo'), 'echo:relay-e2e');

        // 错误传播：页面抛错应以 isError result 返回，而非挂死。
        const failure = await client.callTool({ name: 'extension_fail', arguments: {} });
        assert.equal(failure.isError, true, 'extension_fail should return isError');
        assert.match(readText(failure, 'extension_fail'), /expected relay failure/);

        // 工具清单里应同时看到静态管理工具。
        assert.ok(toolNames.includes('webmcp_list_sources'), 'management tools missing');
        assert.ok(toolNames.includes('webmcp_list_tools'), 'management tools missing');
      } finally {
        await client.close().catch(() => {
          // relay 子进程随 stdio 关闭退出；兜底忽略关闭错误
        });
        if (context) {
          try {
            await context.close();
          } finally {
            rmSync(userDataDirectory, { recursive: true, force: true });
          }
        } else {
          rmSync(userDataDirectory, { recursive: true, force: true });
        }
      }
    }
  );
});
