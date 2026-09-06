# WebMCP Extension Relay

Local MCP relay for browser WebMCP tools. The browser source is the
**WebMCP Chrome extension** (`packages/chrome-extension`): its service worker
connects to this relay over localhost WebSocket and exposes the WebMCP tools
(`document.modelContext`) of every open tab to your AI client.

> Forked from upstream
> [`@mcp-b/webmcp-local-relay`](https://github.com/WebMCP-org/npm-packages)
> v5.1.0 (MIT, © Alex Nahas). This fork removes the embed iframe browser
> route (script tag + hidden `widget.html` iframe); the wire protocol is
> unchanged, so the expected browser client is the Chrome extension.

```text
 Browser (Chrome)                     Local Machine
┌──────────────────────┐             ┌──────────────────────┐
│  Tabs with WebMCP    │             │                      │
│  tools               │             │ webmcp-extension-    │
│        ▲             │  WebSocket  │   (MCP server)       │
│  Extension service   ├────────────▶│                      │
│  worker (per-tab     │  localhost  │                      │
│  source clients)     │             │                      │
└──────────────────────┘             └──────────┬───────────┘
                                                │
                                          stdio │ JSON-RPC
                                                │
                                     ┌──────────▼───────────┐
                                     │  Claude / Cursor /   │
                                     │  any MCP client      │
                                     └──────────────────────┘
```

## Install

Build and run from this workspace (not published to npm):

```bash
pnpm install
pnpm --filter webmcp-extension-relay build
node packages/webmcp-extension-relay/dist/cli.mjs
```

Add the stdio command to your MCP client config — works with Claude Desktop,
Cursor, Windsurf, Claude Code, or anything that speaks MCP:

```json
{
  "mcpServers": {
    "webmcp-extension-relay": {
      "command": "node",
      "args": ["/absolute/path/to/webmcp-example/packages/webmcp-extension-relay/dist/cli.mjs"]
    }
  }
}
```

The Chrome extension connects automatically via port discovery (9333–9348) —
no configuration needed on either side.

## Use

Once connected, your AI client can see and call tools from any open browser
tab where the extension is active:

1. `webmcp_list_sources` — see which tabs are connected (title, URL, origin)
2. `webmcp_list_tools` — see all available tools
3. Call any tool directly by name (e.g., `create_issue`, `search_docs`)

Tools appear and disappear automatically as you open, reload, and close tabs.
Tools that require MCP task execution are omitted, and multi-round
`input_required` results return an error.

---

## Reference

### Exposed Tools

The relay exposes three static management tools that are always available:

| Tool                  | Description                                                                         |
| --------------------- | ----------------------------------------------------------------------------------- |
| `webmcp_list_sources` | Lists connected browser tabs that publish tools, with tab metadata                  |
| `webmcp_list_tools`   | Lists all relayed tools with source info                                            |
| `webmcp_open_page`    | Opens a URL, or in server mode refreshes a connected source page by matching origin |

**Dynamic tools** are registered directly on the MCP server using the original
tool name, sanitized to `[a-zA-Z0-9_]`. When tools from different tabs share a
name, a short tab-ID suffix is appended for disambiguation:

- Single provider: `get_issue`
- Multiple providers with the same name: `search_ed93`, `search_a1b2`

Names are limited to 128 characters. Sanitization, truncation, or tab-prefix
collisions receive deterministic `_2`, `_3`, and later suffixes.

### CLI Options

```text
webmcp-extension-relay [options]

  --host, -H               Bind host for local websocket relay (default: 127.0.0.1)
  --port, -p               Preferred root port for the local relay cluster (default: 9333)
  --widget-origin          Allowed browser client origin(s), comma-separated; supports <scheme>://* wildcards (default: chrome-extension://*)
  --allowed-origin         Deprecated alias for --widget-origin
  --ws-origin              Deprecated alias for --widget-origin
  --label                  Human-readable relay label reported during discovery
  --workspace              Optional workspace name reported during discovery
  --relay-id               Stable relay identifier reported during discovery
  --invoke-timeout         Browser tool invocation timeout in milliseconds (default: 65000)
  --max-payload            Maximum WebSocket payload size in bytes (default: 10000000)
  --help, -h               Show help
```

Examples:

```bash
# Default: loopback on port 9333, extension origins only
node dist/cli.mjs

# Custom port
node dist/cli.mjs --port 9444

# Pin a specific extension id (packed installs have a stable id)
node dist/cli.mjs --widget-origin chrome-extension://abcdefghijklmnop

# Additionally trust tools from a specific website
node dist/cli.mjs --widget-origin chrome-extension://*,https://myapp.com
```

### Security

- Binds to `127.0.0.1` by default (loopback only, not accessible from your network).
- The default `allowedOrigins` is `chrome-extension://*`: only Chrome extension
  contexts may register tools. Host page origins (`https://...`) are rejected
  unless explicitly allowed via `--widget-origin`.
- `--widget-origin` validates the browser's WebSocket `Origin` header. For the
  extension this origin is issued by Chrome itself (`chrome-extension://<id>`)
  and cannot be spoofed by web pages. Unpacked installs get a random id —
  match them with the `chrome-extension://*` scheme wildcard, or pin the
  extension's manifest `key` for an exact allowlist.
- `--widget-origin` is not local-process authentication. An Origin-less
  browser-protocol client falls back to its claimed `hello.origin`, while the
  internal relay-to-relay protocol is outside this browser-origin check. Keep
  the relay bound to loopback unless you add a separate trusted boundary.
- [Chrome 147 and later](https://developer.chrome.com/release-notes/147) can
  ask for Local Network Access permission before opening the loopback
  WebSocket. This browser permission is separate from relay configuration.

### Architecture

```text
┌──────────────────────────────────────┐
│        MCP Client                    │
│   (Claude, Cursor, Windsurf, etc.)   │
└──────────────────┬───────────────────┘
                   │ stdio / JSON-RPC
┌──────────────────▼───────────────────┐
│        LocalRelayMcpServer           │
│   webmcp_list_sources                │
│   webmcp_list_tools                  │
│   + dynamic tools from browser       │
└──────────────────┬───────────────────┘
                   │ in process
┌──────────────────▼───────────────────┐
│        RelayBridgeServer             │
│   Manages connections, routes calls  │
└──────────────────┬───────────────────┘
                   │ WebSocket (ws://127.0.0.1:9333)
┌──────────────────▼───────────────────┐
│   Chrome extension service worker    │
│   (packages/chrome-extension)        │
│   one RelaySourceClient per tab      │
└──────────────────┬───────────────────┘
                   │ chrome.tabs.connect + page-tools protocol
┌──────────────────▼───────────────────┐
│        Host page                     │
│   WebMCP runtime + registered tools  │
└──────────────────────────────────────┘
```

**How it connects:** The extension's service worker probes loopback ports
9333–9348 with the `webmcp-discovery.v1` sub-protocol, performs a two-step
`hello` handshake, then keeps one WebSocket per tab (a relay "source"). Tool
listing and invocation are bridged to the page through the extension's
existing content-script channel (`chrome.tabs.connect`), so pages stay
untouched — no scripts are injected into websites.

After a disconnect, the extension client retries the last endpoint after about
`500ms`, rescans the relay range at `10s`, `20s`, and `30s`, then enters a
dormant state probing every two minutes.

**Client mode:** When a candidate port is already owned by a compatible WebMCP
relay, a second relay instance joins it in client mode and proxies tool
operations through it. A non-relay service is skipped while scanning the
default range; an explicitly selected occupied port fails. If the server relay
later stops, the client promotes itself back to server mode. This enables
multiple MCP clients to share the same browser connections without manual
configuration.

### WebMCP Standard Status

WebMCP is an emerging web platform proposal. This relay works with the current
native Chrome preview and MCP-B runtimes, but native extension details can
still change as implementations mature.

- [W3C WebML CG draft](https://webmachinelearning.github.io/webmcp/)
- [Proposal repository](https://github.com/webmachinelearning/webmcp)

For Chromium/Chrome Canary native preview testing:

1. Open `chrome://flags/#enable-webmcp-testing`
2. Enable **WebMCP for testing**
3. Restart the browser

### Troubleshooting

| Problem                  | Fix                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `No sources connected`   | Ensure the Chrome extension is loaded (built `dist/`) and the relay process is running                      |
| `No tools listed`        | Ensure tools are registered on the page's WebMCP runtime. If tools register after load, the extension picks them up on the next `toolsChanged` push |
| `Tool not found`         | Tab reloaded or disconnected — call `webmcp_list_tools` again to refresh                                    |
| Connection blocked       | Default policy only allows extension origins; add `--widget-origin chrome-extension://*,https://myapp.com` to trust a website |
| `Host response timeout:` | The page exceeded the invocation timeout (default 65s). Raise `--invoke-timeout`                            |

---

## Contributing

### Project Layout

```text
src/
├── cli.ts                      CLI entry point
├── cli-utils.ts                CLI argument parsing
├── mcpRelayServer.ts           MCP server (stdio + dynamic tool sync)
├── bridgeServer.ts             WebSocket relay server
├── registry.ts                 Multi-source aggregation and deduplication
├── naming.ts                   Tool name sanitization and namespacing
├── schemas.ts                  Browser <-> relay protocol schemas
└── index.ts                    Public API exports
```

### Build and Test

From repository root:

```bash
pnpm install
pnpm --filter webmcp-extension-relay build
pnpm --filter webmcp-extension-relay test
```

## License

MIT. Upstream code © Alex Nahas and contributors
([WebMCP-org/npm-packages](https://github.com/WebMCP-org/npm-packages));
modifications in this fork remove the embed iframe browser route and tighten
the default origin policy.
