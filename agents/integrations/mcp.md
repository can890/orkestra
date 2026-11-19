# MCP

## Main Files

- `src/main/core/mcp/services/McpService.ts`
- `src/main/core/mcp/utils/` — adapters, catalog, config IO, config paths, conversion
- `src/main/core/mcp/controller.ts`
- `src/core/primitives/mcp/api/`
- `src/core/features/mcp/browser/` (`mcp-view.tsx`, `components/`)

## Current Behavior

- MCP server configs are read, adapted, merged, and written across supported agent ecosystems
- provider-specific config formats are handled through adapters in `src/main/core/mcp/utils/`
- the renderer MCP UI manages installed servers and catalog entries
- Chat's MCP list reports configured servers, not inferred connection health. Codex's recognized
  synthetic startup failures are translated by its ACP enrichment hook and displayed on the
  composer MCP trigger/popover instead of opening a transcript turn. Startup errors are scoped to
  the current Session activation and are not retained as configuration. Other provider diagnostics
  and ordinary failed MCP tool invocations remain unchanged; there is no health polling.

## Account connections

- Service cards expose visible connect/reconnect actions, including catalog services installed
  through a stdio bridge. Reconnection uses the catalog's official OAuth endpoint.
- The application catalog's machine selector owns the target host; the connection sheet shows
  its name. Each machine needs its own account authorization. A local login does not repair a
  remote machine's credentials.
- The connection sheet snapshots the host and provider selection for the current attempt;
  live-model refreshes must not cancel or restart OAuth. Closing cancels pending login; failure
  exposes an explicit retry. A successful save applies to new agent conversations.
- `src/core/features/mcp/node/connection-manager.ts` handles browser authorization and sends
  the grant through the selected host's `agentConfig.installMcpOAuth`. The host runtime installs
  the protected credentials and bridge, replacing the selected agents' existing server config.

## Orkestra's own tool servers

- Orkestra adds conversation-scoped stdio MCP servers to ACP sessions at attach time
  (`src/core/features/conversations/node/wire-controller.ts`, `conversationMcpServers`
  providers merged after the conductor's `orkestra` server, never replacing it):
  - `orkestra` — conductor tools, only for Orkestra conductor conversations
    (`agents/architecture/orchestra.md`).
  - `orkestra-browser` — in-app browser tools for every ACP conversation
    (`src/core/features/browser/node/agent-tools/`): tabs, page snapshot with element refs,
    trusted clicks/typing, screenshots, console. Tool calls are confined to the conversation's
    task; loopback URLs of remote (SSH) workspaces are reached through preview port forwarding.
    - Network: `network_requests` / `network_response` read a per-tab ring buffer fed by the CDP
      Network domain (`src/main/host/browser/automation/network-log.ts`). Capture starts only
      when an agent first uses the tab (`agentBrowserPort.page()`); Authorization, Cookie and
      Set-Cookie headers are redacted and only text bodies are returned, size-capped.
    - Dialogs: `Page.javascriptDialogOpening` is tracked by the engine; snapshots and action
      results report an open alert/confirm/prompt, page operations fail fast instead of hanging,
      and `handle_dialog` answers it through CDP without waiting for the operation queue.
      Electron's own message box for the dialog may stay visible until the user closes it.
    - Recording: `record_start` / `record_stop` / `replay` use locator steps
      (`{ selector, text }`, validated by `src/core/primitives/browser/api/recorded-steps.ts`)
      instead of refs. User actions (`includeUser`, or the toolbar's "Kaydı başlat") come from
      `recorder-script.ts` in the agent's isolated world via nonce-tagged `console.debug`
      messages; agent input is filtered out by operation time windows and password values are
      never recorded.
    - Agent tabs open with the "Ajan sekmeleri için profil" setting (`browser.agentProfile`):
      the user's default profile, the shared `persist:orkestra-browser-agent` partition, or the
      per-task isolated partition. User-opened tabs are unaffected.
  - `orkestra-simulator` — iOS Simülatör araçları (`list_devices`, `screenshot`, `open_url`,
    `install_app`, `launch_app`; `src/core/features/simulator/node/agent-tools/`). Yalnızca macOS'ta,
    yerel (SSH olmayan) görevlerde ve `simulator.agentToolsEnabled` ayarı açıkken (varsayılan
    kapalı; simülatör panelindeki anahtar) eklenir; ayar her çağrıda yeniden denetlenir. Tüm
    `xcrun simctl` komutları `SimulatorService` (`node/simctl.ts`) üzerinden argv dizisiyle
    çalışır: UDID katı desenle, paket kimliği/URL/`.app` yolu doğrulanarak denetlenir, shell
    kullanılmaz. simctl dokunma/klavye girişi desteklemediği için bu araçlar da girdi göndermez.
    Kullanıcı arayüzü: görev sekmesi "iOS Simülatör" (yeni sekme menüsü; macOS + yerel proje),
    sekme görünürken ~2 fps `screenshot-poller.ts` ile canlı görüntü; sekme kapanınca/etkin
    olmayınca yoklama durur.
  - `orkestra-chrome` — drives the user's real Chrome through the unpacked MV3 extension in
    `apps/chrome-extension/` (no build step, no `package.json`). **High risk, off by default.**
    - Slice: `src/core/features/chrome/` (`api/contract.ts`, `node/chrome-bridge-server.ts` WebSocket
      transport, `node/chrome-bridge-service.ts` settings/token/tool server, settings page under
      Ayarlar > Chrome). Composition: `src/main/host/chrome/chrome-bridge-operations.ts`.
    - The bridge listens only on `127.0.0.1` and only after the user turns it on (setting kept in
      the kv table `chrome-bridge:settings`, no migration). Handshake: `Origin` must match
      `chrome-extension://<32 letters>`, `Host` must be loopback, the 32-byte hex pairing token
      travels as a `token.<hex>` WebSocket subprotocol and is compared in constant time; one
      extension connection at a time (a second one gets 409). The token lives in the encrypted
      secrets store (`chrome.bridge.token`), is never logged or part of the status output, and
      rotating it drops the connected extension.
    - The tool server is added to a conversation only when the bridge is enabled, an extension is
      connected and the conversation runs on the local host (never over SSH). Tools: `tabs_list`,
      `tab_create`, `navigate`, `read_page`, `click`, `type`, `screenshot`; page content is returned
      under an "untrusted web page content" banner. There is no arbitrary-script tool.
    - Extension side (`lib/policy.js`, `lib/page-functions.js` are unit-tested from the desktop
      vitest): only `optional_host_permissions`; the user grants each site by clicking in the
      popup/options page, the agent cannot. Only http/https; no chrome://, extension, Web Store or
      file:// pages; typing into password and payment-card fields is refused at typing time; no
      cookies/history/passwords/downloads permissions. Injected functions must stay self-contained
      (`executeScript` ships only the function source, not module-level constants).
  - `orkestra-memory` — shared project memory, only for projects whose "Ortak hafıza" setting is on
    (default off; `src/core/features/project-memory/`). Tools: `memory_list`, `memory_read`,
    `memory_write`, `memory_delete`.
    - Storage: `userData/project-memory/projects/<projectId>/<name>.md` (front matter `description:`
      + markdown body) plus a generated `MEMORY.md` index; the per-project toggle lives in the
      versioned JSON `userData/project-memory/settings.json` (no DB migration).
    - Scope: the project comes from the conversation context resolved when the server is attached
      (bridge token -> conversation -> project); tools have no project argument. Names must match
      `^[a-z0-9][a-z0-9-]{0,63}$` (optional `.md` is stripped, `memory` and Windows device names are
      reserved); files are only read/written as regular files inside the project directory
      (`lstat` + realpath checks, symlinks refused). Limits: 32 KB per note, 200 notes per
      project, 160-char one-line description. Writes are serialized per project and use temp
      file + rename, so concurrent agents cannot corrupt a note or the index.
    - Secrets: `memory_write` says never to store secrets and rejects content/descriptions that
      `redactSecrets` (`@orkestra/shared/logger`) would change (false positives such as
      `password: see vault` are possible; the error tells the agent to remove them).
    - Prompt injection: with the setting on, the first message of a new chat carries a hidden
      "Project memory" block (name + one-line description only, <= 6000 chars, framed as past notes
      written by other agents, not instructions). Chats created with an initial prompt get it on
      the first `initialQueue` item in the conversations wire controller; other chats get it from
      `acp-chat-panel` via `withProjectMemoryContext`. Full text only comes from `memory_read`.
    - UI: project Settings tab -> "Ortak hafıza" section (toggle, list, edit, delete). Turning it
      off after a session started makes tool calls fail; new servers only appear on new/restarted
      sessions.
  - `orkestra-computer` — desktop control (macOS, local projects only; **high risk**), slice
    `src/core/features/computer-use/`. Tools: `screenshot`, `mouse_move`, `click`, `drag`,
    `type_text`, `key`.
    - Double lock, default off: the global setting `computerUse.enabled` (Settings > General,
      macOS only) AND a per-conversation enable done by the user in the chat composer chip. The
      conversation lock is in memory only (resets on restart). `ComputerAgentTools` adds the
      server to a session only when both are open (`ComputerUseState.check`), and re-checks on
      every call, so "Durdur" (or turning the setting off) makes tools fail immediately. The only
      code that opens the conversation lock is the UI-facing wire controller
      (`computerUse.setConversationEnabled`); no agent tool, MCP method or config file can. Never
      add that domain to a remote-access allow list. MCP servers are fixed when a session starts,
      so enabling mid-session takes effect after the session restarts.
    - No injection: `screencapture`, `sips` and `osascript` run through an injectable
      `ProcessRunner` with argv arrays (no shell). Input uses one fixed JXA script
      (`COMPUTER_INPUT_JXA`, CGEvent); text, key codes and coordinates reach it only as JSON on
      stdin. Key names come from an allow list, coordinates must be finite and inside the main
      display, text is capped (2000 chars) and typed in chunks so stop works mid-typing. Do not
      name a top-level JXA function `run` (osascript would execute it twice).
    - Permissions: Accessibility and Screen Recording are only *read* (`isTrustedAccessibilityClient(false)`,
      `getMediaAccessStatus('screen')`); missing ones return an error pointing at the System
      Settings pane. The app never prompts for or bypasses them.
    - Every action goes to an in-memory activity log (tool, coordinates, text length, never the
      text) shown in the chip and to the app log.
  - `orkestra-widgets` — one tool, `show_widget` (`{ title <= 80, html | svg }`, 200 KB total), ACP
    conversations only (`src/core/features/widgets/node/`; TUI conversations do not get it). It adds
    no authority: the server only validates the input and answers "shown". The drawing is done by
    the chat UI. Turn it off with the "Sohbet içi widget'lar" setting (`widgets.enabled`, default
    on; applies to sessions started afterwards, and calls are refused while it is off).
    - Persistence: the ACP reducer keeps the validated call input on the transcript tool node
      (`widget`, only for `orkestra-widgets` `show_widget`, see
      `packages/core/src/primitives/acp-transcript/api/widget.ts`), so history replays redraw it
      without separate storage. This relies on the provider replaying `rawInput` on history load.
    - Rendering (`packages/chat-ui/src/components/rows/widget/`): inline iframe with
      `sandbox="allow-scripts"` only and a `srcdoc` whose first element is a strict CSP `<meta>`
      (`default-src 'none'; script-src/style-src 'unsafe-inline'; img-src/font-src data:`, plus
      `base-uri 'none'; form-action 'none'`); SVG is drawn inside the iframe too. Agent markup goes
      after our `<head>`, `<base>`/`<meta http-equiv>` are dropped. The widget's only channel to
      the app is `{ type: 'orkestra-widget-height', height }`, accepted solely from that iframe's
      `contentWindow`, exact schema, clamped to 40-800 px. Theme colours (`--widget-bg`, `-fg`,
      `-muted`, `-border`, `-accent`) come from the chat theme tokens and are injected only if they
      match a colour pattern. Do not loosen the sandbox or CSP; add no widget-to-app messages.
- Shared plumbing lives in `src/core/services/agent-tools/`: one loopback RPC server with a
  per-conversation Bearer token, a dependency-free bridge script (structured text/image content),
  and one OpenSSH reverse Unix-socket forward per SSH connection (`~/.orkestra/agent-tools`).
- A provider that fails or takes longer than 10 s is left out; the session still starts. MCP
  servers are fixed when a session materializes, so running sessions get new servers only after
  they restart.

### TUI/PTY conversations

- `TuiConversationProvider` asks the same providers (`collectConversationMcpServers` in
  `src/core/features/conversations/node/conversation-mcp-servers.ts`, shared with the ACP attach
  path; one provider list in `ServicesBundle.conversationMcpServers`) and sends the specs as the
  optional `mcpServers` field of the `tuiAgents.start/resume` input. Specs are host-aware: for SSH
  hosts the provider already returns the remote node/bridge paths and reverse-tunnel socket.
- The tui-agents runtime (local worker or remote workspace-server) hands them to the CLI only when
  the provider plugin implements `prompt.buildSessionMcp`
  (`packages/core/src/services/agent-plugins/api/plugins/capabilities/prompt.ts`). Files go into a
  per-spawn `mkdtemp` directory (`orkestra-tui-mcp-*`, 0700; files 0600, `wx`) on the machine that
  runs the CLI, are removed on stop/exit/evict/respawn/dispose, and stale ones (>24 h) are swept at
  worker start. `mcpServers` is never persisted with the session intent (it carries tokens), and any
  preparation failure only logs a warning — the CLI starts without the tools.
- Claude Code: `--mcp-config=<file>` prepended (additive; the `=` form stops the variadic flag from
  swallowing the positional prompt). Tokens live only in the 0600 JSON file.
- Codex: `-c mcp_servers.<name>={command=…,args=[…]}` (TOML inline table, verified with
  `codex -c … mcp get <name> --json`), prepended before any `resume` subcommand; `config.toml` is
  untouched. On POSIX the server env goes to a 0600 `<name>.env` file loaded by a `/bin/sh`
  wrapper, so tokens appear neither in argv nor in Codex's own env (which leaks into agent shells
  and is not propagated into existing tmux servers). On Windows env goes into an inline `env` table.
- Other providers are skipped. Kimi Code 0.29 has no per-session MCP flag; Copilot
  (`--additional-mcp-config`), OpenCode (`OPENCODE_CONFIG_CONTENT`), Amp and Goose were not
  verified against installed CLIs. Server names must match `[A-Za-z0-9_-]{1,64}`.
- Remote hosts need a workspace-server that knows the `mcpServers` field; older servers drop it
  (zod strips unknown keys) and start the CLI without tools.
- Tokens are in-memory per desktop run. A tmux session that outlives the desktop keeps the old
  token and loses the tools until the conversation is restarted.

## Rules

- do not assume all providers support the same MCP transport types
- keep canonical MCP data in shared types and adapt at the edges
- if you add provider-specific MCP behavior, update both service and UI compatibility handling
