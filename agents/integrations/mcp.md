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
- Shared plumbing lives in `src/core/services/agent-tools/`: one loopback RPC server with a
  per-conversation Bearer token, a dependency-free bridge script (structured text/image content),
  and one OpenSSH reverse Unix-socket forward per SSH connection (`~/.orkestra/agent-tools`).
- A provider that fails or takes longer than 10 s is left out; the session still starts. MCP
  servers are fixed when a session materializes, so running sessions get new servers only after
  they restart. TUI/PTY conversations are not covered.

## Rules

- do not assume all providers support the same MCP transport types
- keep canonical MCP data in shared types and adapt at the edges
- if you add provider-specific MCP behavior, update both service and UI compatibility handling
