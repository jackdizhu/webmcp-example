// i18n English (US) dictionary. Keys must mirror zh-CN exactly (Record<MessageKey, string>).
// Placeholders use the {name} form and are substituted by t() at render time.
export const enUS: Record<import('./zh-CN').MessageKey, string> = {
  // ---- Common ----
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.back': 'Back',
  'common.toolsCount': '{count} tools',
  'common.tabLabel': 'Tab {id}',
  'common.state.running': 'Running',
  'common.state.ok': 'OK',
  'common.state.fail': 'Failed',

  // ---- Header ----
  'header.title': 'WebMCP Page Tools Assistant',
  'header.settings': 'Settings',
  'header.langTitle': '切换语言 / Switch language',

  // ---- Tab bar ----
  'tab.chat': 'Agent Chat',
  'tab.debug': 'Tools Debug',
  'tab.relay': 'Relay Calls',
  'tab.datasource': 'Data Sources',
  'tab.a2a': 'Remote Agents (A2A)',
  'tab.settings': 'Settings',
  'tab.abort': 'Abort',
  'phase.agent': 'Agent chat in progress',
  'phase.relay': 'Relay call in progress',

  // ---- Relay status bar ----
  'relayBar.state.connected': 'Connected',
  'relayBar.state.connecting': 'Connecting',
  'relayBar.state.reconnecting': 'Reconnecting',
  'relayBar.state.dormant': 'Dormant',
  'relayBar.state.stopped': 'Stopped',
  'relayBar.summary.connected': 'Relay connected · {count} sources',
  'relayBar.summary.connecting': 'Relay connecting · {count} sources',
  'relayBar.summary.lnaBlocked': 'Relay blocked by browser local-network permission · expand for fix steps',
  'relayBar.summary.dormant': 'Relay dormant · no local relay found',
  'relayBar.summary.standby': 'Relay standby · no tab selected',
  'relayBar.noEndpoint': 'No connection established',

  // ---- Chat page ----
  'chat.agentLabel': 'Agent',
  'chat.inspectPrompt': 'View Prompt',
  'chat.switchConfirm': 'Switching to "{name}" starts a new session; the current chat history will be cleared.',
  'chat.switchConfirmYes': 'Confirm Switch',
  'chat.pending': 'Agent is working…',
  'chat.tracePending': 'Running…',
  'chat.traceCollapse': 'Collapse ▲',
  'chat.traceExpand': 'Expand ▼',
  'chat.emptyTitle': 'Two ways to verify page WebMCP tools:',
  'chat.emptyChat': 'Chat — talk with an agent to discover and call page tools (configure the API Key in Settings);',
  'chat.emptyDebug': 'Debug — run tools manually without an LLM and inspect results (no key required; entry in the Settings panel).',
  'chat.emptyExample': 'e.g. "List the page tools and call them one by one to verify the responses".',
  'chat.composerPlaceholder': 'e.g. List page tools and call get_status to verify the response',
  'chat.send': 'Send',

  // ---- App-level dynamic messages (pushUiMessage / notifyA2a) ----
  'msg.missingApiKey': 'Please fill in the API Key on the "Settings" page before starting a chat.',
  'msg.agentSwitched': 'Switched to "{name}". A new session has started.',
  'msg.promptHeader': 'Current system prompt (layered composition with section-source annotations):\n\n{prompt}',
  'msg.promptEmpty': 'The current system prompt is empty; the built-in default prompt will be used.',
  'msg.settingsSaved': 'Settings saved.',
  'msg.settingsSavedConsole':
    'Settings saved. Console output is on: right-click the side panel → "Inspect" to open the console, then type a traceId in the filter box to view the full chain of that turn.',
  'msg.a2aSyncFailed': 'Failed to fetch cards for these remote agents; they will be unavailable in chat: {list}',
  'msg.a2aSaveFailed': 'Failed to save A2A configuration: {message}',
  'msg.a2aTokenSaveFailed': 'Failed to save the Bearer Token for "{id}": {message}',

  // ---- Debug page ----
  'debug.parameters': 'Parameters',
  'debug.noParams': 'This tool takes no parameters (leave empty for {})',
  'debug.required': 'Required',
  'debug.optional': 'Optional',
  'debug.defaultValue': 'default {value}',
  'debug.enumValues': 'Allowed: {values}',
  'debug.tool': 'Tool',
  'debug.noTools': '(no tools available)',
  'debug.args': 'Arguments (JSON)',
  'debug.argsPlaceholder': '{"key": "value"}; empty means {}',
  'debug.running': 'Running…',
  'debug.execute': 'Run',
  'debug.format': 'Format',
  'debug.fillTemplate': 'Fill Template',
  'debug.refreshTools': 'Refresh Tools',
  'debug.resultBadge': '{state} · {elapsed}ms',
  'debug.rawJson': 'Raw JSON',
  'debug.sendToChat': 'Send to Chat (agent continues analyzing)',
  'debug.recentRuns': 'Recent Runs ({count})',
  'debug.sendToChatShort': 'Send to Chat',
  'debug.listFetchFailed': 'Failed to fetch the tool list: {message}',

  // ---- Relay page ----
  'relayPage.title': 'Relay Call Log (read-only)',
  'relayPage.running': '{count} call(s) running…',
  'relayPage.terminated':
    'Wait terminated and the execution lock has been released; background calls will still finish and be logged below.',
  'relayPage.empty':
    'No call records yet. When an external MCP agent calls page tools via relay, they will appear here in real time. To select data sources, go to the "Data Sources" page.',

  // ---- Data source page ----
  'ds.adjust': 'Adjust Sources',
  'ds.lockedHint': 'Agent chat or relay call in progress; adjustment unavailable for now.',
  'ds.picker.title': 'Data Source Selection',
  'ds.picker.globalSelection':
    'Global selection: {count} tab(s) selected (shared by agent / tools debug / relay; does not follow tab switches)',
  'ds.picker.empty': 'No tabs available',
  'ds.picker.reset': 'Reset to active tab (single)',
  'ds.summary.title': 'Connection Status',
  'ds.summary.empty': 'No http(s) tabs',
  'ds.summary.stats': '{connected} source(s) connected · {selected} / {total} tabs selected',
  'ds.actions.title': 'Reconnect',
  'ds.actions.hint':
    'webmcp connection = extension → page tool bridge; relay connection = extension → local relay service. During a rebuild, refer to the status bar on top.',
  'ds.actions.webmcp': 'Refresh webmcp',
  'ds.actions.relay': 'Refresh relay',
  'ds.actions.rebuilding': 'Rebuilding…',

  // ---- Settings page ----
  'settings.logsCount': 'Local logs: {count}',
  'settings.exportLogs': 'Export Logs',
  'settings.clearLogs': 'Clear Logs',
  'settings.exported': 'Exported {name}',
  'settings.noLogsToExport': 'No logs to export',
  'settings.logsCleared': 'Logs cleared',
  'settings.editConfig': 'Edit Config',
  'settings.lockedHint': 'Agent chat or relay call in progress; editing unavailable for now.',

  // ---- Settings summary (view mode) ----
  'settings.summary.title': 'Active Configuration (saved)',
  'settings.summary.protocol': 'API Protocol',
  'settings.summary.model': 'Model',
  'settings.summary.maxHistoryTurns': 'Max History Turns',
  'settings.summary.consoleOutput': 'Console Output',
  'settings.summary.on': 'On',
  'settings.summary.off': 'Off',
  'settings.summary.notSet': '(not set)',
  'settings.summary.empty': '(empty)',
  'settings.summary.apiPathEmpty': '(empty; you will be prompted to configure it when chatting)',
  'settings.summary.protocolOpenai': 'OpenAI compatible (chat completions)',
  'settings.summary.protocolAnthropic': 'Anthropic (Messages API)',
  'settings.summary.dirtyHint': 'The form has unsaved changes; the values above are the saved ones.',

  // ---- Settings form (edit mode) ----
  'settings.form.protocol': 'API Protocol',
  'settings.form.protocolHint': 'Anthropic uses /v1/messages (x-api-key auth; max_tokens is required).',
  'settings.form.maxTokens': 'Max Tokens',
  'settings.form.maxTokensHint': 'Maximum tokens per reply (default 4096; used by the Anthropic protocol only).',
  'settings.form.model': 'Model',
  'settings.form.systemPrompt': 'System Prompt',
  'settings.form.systemPromptPlaceholder': 'Leave empty to use the built-in page-tool verification prompt',
  'settings.form.maxHistoryTurns': 'Max History Turns',
  'settings.form.maxHistoryTurnsHint':
    'Maximum number of history turns sent to the LLM per turn (default 5; 0 = no trimming). Trimming works in whole turns, and tool results are trimmed together with their turn, which can significantly reduce token usage.',
  'settings.form.consoleOutput':
    'Console output (mirrors logs to the console with a [traceId] prefix; by default logs are written locally only)',
  'settings.form.apiPathHint':
    'Request path appended after the Base URL; when cleared it does not fall back to a default, and starting a chat will prompt you to configure it. Anthropic default: /v1/messages; OpenAI-compatible default: /chat/completions.',
  'settings.form.busyHint': 'Agent chat or relay call in progress; saving unavailable for now.',
  'settings.form.dirtyHint': 'Unsaved changes: they take effect after Save; Cancel reverts. Leaving this page will not save.',
  'settings.form.keyLocalHint': 'The key is stored only in local chrome.storage.local and never enters the code repository.',

  // ---- A2A page ----
  'a2a.hint':
    'Remote Agents (A2A): bind remote A2A agents to an agent. Enabled ones are exposed to chat as a2a__<id>__send_task tools, and the agent delegates tasks automatically based on card descriptions; bindings are persisted per agent.',
  'a2a.editTarget': 'Edit Target Agent',
  'a2a.targetActive': '{name} (active)',
  'a2a.viewTarget': 'Showing the bindings of "{name}".',
  'a2a.viewTargetNotActive': ' ⚠ This is not the currently active agent: bindings of the active agent are what take effect in chat.',
  'a2a.editItemTitle': 'Edit Binding · {id}',
  'a2a.edit': 'Edit',
  'a2a.enabled': 'Enabled',
  'a2a.disabled': 'Disabled',
  'a2a.testing': 'Testing…',
  'a2a.testConnection': 'Test Connection',
  'a2a.testFailed': 'Connection test failed: {message}',
  'a2a.cardUrl': 'Card URL',
  'a2a.endpointOverride': 'Endpoint Override',
  'a2a.noOverride': 'Not overridden (uses the card endpoint by default)',
  'a2a.tokenSet': 'Set',
  'a2a.tokenUnset': 'Not set',
  'a2a.noBindings': 'No remote agents bound yet.',
  'a2a.noEditableAgent': 'No editable agent.',
  'a2a.enableTitle': 'When enabled, this remote agent is exposed to chat as the a2a__<id>__send_task tool',
  'a2a.remove': 'Remove',
  'a2a.tokenPlaceholder': 'bearer token for {id} (optional)',
  'a2a.endpointPlaceholder':
    'JSON-RPC endpoint override (optional; leave empty to use the card endpoint; for Dify use http://host/e/<app>/a2a)',
  'a2a.cardUrlError': 'The card URL of "{id}" must be a valid HTTP(S) URL (usually /.well-known/agent-card.json).',
  'a2a.add.title': 'Add Binding',
  'a2a.add.idPlaceholder': 'ID (agentKey; letters/digits/underscore/hyphen only; immutable after creation)',
  'a2a.add.cardUrlPlaceholder': 'Agent Card URL (https://…/.well-known/agent-card.json)',
  'a2a.add.endpointPlaceholder':
    'JSON-RPC endpoint override (optional; uses the card endpoint by default; for Dify use http://host/e/<app>/a2a)',
  'a2a.add.tokenPlaceholder': 'Bearer Token (optional)',
  'a2a.add.idInvalid': 'Invalid ID: only letters, digits, underscore and hyphen are allowed (immutable after creation).',
  'a2a.add.cardUrlInvalid': 'The card URL must be a valid HTTP(S) URL (usually /.well-known/agent-card.json).',
  'a2a.add.noAgent': 'No active agent.',
  'a2a.add.idExists': 'ID "{id}" already exists (agentKey is immutable; to change the address, edit the card URL directly).',
  'a2a.add.submit': 'Add & Enable',
};
