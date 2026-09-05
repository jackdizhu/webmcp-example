import { connectWebMCPClient } from '../core/content-script';
import { startPageToolsBridge } from '../core/page-tools-bridge';

async function waitForDocument(): Promise<void> {
  if (document.readyState !== 'loading') return;
  await new Promise<void>((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

async function main(): Promise<void> {
  const client = await connectWebMCPClient(
    {
      name: 'webmcp-extension-main',
      version: '1.0.0',
    },
    {
      listChanged: {
        tools: {
          onChanged(error, tools) {
            if (error || !tools) {
              console.error('[WebMCP] Failed to refresh page tools:', error);
              return;
            }
            console.info(
              '[WebMCP] Page tools updated:',
              tools.map(({ name }) => name)
            );
          },
        },
      },
    }
  );

  // Keep this connection alive across BFCache restores; document teardown owns final cleanup.
  await waitForDocument();
  const { tools } = await client.listTools();
  console.info(
    '[WebMCP] Page tools:',
    tools.map(({ name }) => name)
  );

  // 向扩展内其他上下文（侧边栏聊天框）暴露页面工具的代理桥接。
  // 桥接生命周期与 content script 一致：文档销毁时随上下文一并回收，无需手动停止。
  startPageToolsBridge(client);
}

void main().catch((error) => {
  console.error('[WebMCP] Content-script connection failed:', error);
});
