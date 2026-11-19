# Main Process

## Structure

The main process is organized into domain modules under `src/main/core/`. Each domain typically has a `controller.ts` (RPC handlers) and service/implementation files.

## Domain Modules (`src/main/core/`)

- **account** — Orkestra account service, credential store, provider token registry
- **agent-status** — Desktop projection of runtime agent states into SQLite/cache state and renderer status events
- **app** — App lifecycle service and controller
- **conversations** — Conversation CRUD and session start
- **dependencies** — CLI agent detection, probing, dependency management
- **editor** (`src/core/features/editor/node/`) — Workspace-identity file adapter and editor buffer
  service
- **fs** — Filesystem operations with provider pattern (`local-fs.ts`, `ssh-fs.ts`)
- **git** — Git operations (`git-service.ts`, `git-repo-utils.ts`, `detectGitInfo.ts`)
- **github** — GitHub auth, PRs, issues, repos (via `gh` CLI)
- **jira** — Jira integration
- **linear** — Linear integration
- **mcp** — MCP service, adapters, config IO, catalog
- **projects** — Project management with provider pattern (`local-project-provider.ts`), worktree service, project settings, CRUD operations
- **pty** — PTY lifecycle (`local-pty.ts`, `ssh2-pty.ts`), session registry, env setup, spawn utilities
- **repository** — Repository controller
- **settings** — App settings service and schema, provider settings (separate controller)
- **shared** — Shared utilities (OAuth flow)
- **skills** — Skills service and controller
- **ssh** — SSH connection management, credentials, config parsing, client proxy
- **tasks** — Task CRUD (create, delete, archive, restore, provision)
- **terminals** — Terminal lifecycle with provider pattern (`local-terminal-provider.ts`, `ssh-terminal-provider.ts`); lifecycle scripts run in the host scripts runtime (`packages/core/src/runtimes/scripts/`)
- **updates** — Auto-update service

## Other Main Process Areas

- `src/main/app/` — Menu, protocol handler, window creation
- `src/main/lib/` — Logger, telemetry, events, result type, updater error
- `src/main/db/` — Database schema and initialization
- `src/main/utils/` — Shell environment, shell escaping, child process env, external links
- `src/main/core/agent-status/` — Agent status cache projection and runtime bridges
- `src/services/notifications/` — Desktop notification service with persisted feed, Wire LiveModel/event stream, batching, sound, and OS notification sinks

## IPC / RPC Structure

- Domain Wire contracts are assembled in
  `src/core/manifests/shared/desktop-wire-contract.ts`.
- Node controllers and event hosts live in owning slices under `src/core/features/*/node/`.
- Lazy controller factories are contributed by `src/core/manifests/node/controllers.ts`; the
  shared desktop contract remains a hand-composed renderer-safe manifest of slice API contracts.
- `src/main/gateway/desktop-wire.ts` serves the desktop contract over a transferred message port.
- The preload bridge (`src/entry/preload.ts`) exposes only `requestWirePort` and
  `getPathForFile`.

## Keep-Awake And Deep Links

- **Uyanık tutma** (`src/main/host/power/`): app setting `power.keepAwakeWhileWorking`
  (default off). `keep-awake-controller.ts` is the Electron-free decision (setting on AND at
  least one conversation working => exactly one `powerSaveBlocker('prevent-app-suspension')`;
  never the display-sleep mode). `keep-awake-service.ts` feeds it from the
  `AgentStatusService` `status:changed` hook plus a DB count of `working` conversations, with a
  60 s re-count while held. It is started in `boot/phases/background.ts` and released through
  `appScope` on quit.
- **Deep links** (`src/main/host/deep-link/`, parser in
  `src/core/primitives/deep-links/api/deep-link.ts`): only `<scheme>://task|project|conversation/<id>`
  is accepted; anything else (query, fragment, extra segment, userinfo, port, percent-encoding,
  over-long input) is silently ignored. The scheme is `DEEP_LINK_SCHEME` (`orkestra`, or
  `orkestra-canary` for the canary build) so two installs never steal each other's links.
  Links are navigation-only: the main process resolves the id read-only
  (`deep-link-resolver.ts`) and the renderer (`src/renderer/lib/deep-link-requests.ts`) only
  navigates or shows a "not found" toast. Sources: macOS `open-url`, first `process.argv`, and
  `second-instance` argv (exactly one `<scheme>://` value is taken). Cold-start links wait in the
  coordinator queue and are drained by the renderer (`host.takePendingDeepLinks`) after navigation
  restore. `setAsDefaultProtocolClient` runs only when `app.isPackaged`; electron-builder
  `protocols` registers the scheme (see `agents/risky-areas/updater.md`).

## When Editing Here

The menu bar/system tray icon is controlled by the desktop app setting
`interface.showTrayIcon` (Settings → Interface → Application icon, enabled by default).
Create it only after settings load in the services boot phase; Wire settings updates and resets
apply visibility immediately through `SettingsRuntimePort`. Hiding it leaves the app running;
activation or launching the app again restores the main window.

- Check `agents/conventions/main-patterns.md` for controller, service, Result type, and event patterns.
- Check `agents/conventions/ipc.md` for the RPC controller pattern and typing rules.
- Check `agents/risky-areas/pty.md` before touching PTY or provider spawn behavior.
- Check `agents/risky-areas/database.md` before changing persistence or migrations.
