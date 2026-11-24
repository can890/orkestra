# Worktrees

## Main Files

- `packages/core/src/runtimes/workspace-registry/` (creation pipeline, lifecycle steps, activation)
- `packages/core/src/runtimes/scripts/` (lifecycle script execution)
- `packages/core/src/runtimes/host-settings/` (per-host defaults)
- `src/core/features/workspaces/` (desktop wire controllers and UI)
- `.orkestra.json`

## Current Behavior

- task worktrees are created under the project's DB-backed worktree directory setting
- branch prefix defaults to `orkestra` and is configurable in app settings
- generated task branch names use the configured prefix plus a random suffix by default; app repository settings can disable only the random suffix
- worktree creation is managed by the project provider pattern
- creation runs a fast foreground pipeline (`inspect → resolve-base → add-worktree → verify`);
  the base ref is fetched only when it is not locally resolvable
- newly created task branches use `git worktree add --no-track`; the selected base ref is a
  starting point, not the branch's upstream
- gitignored files named in `preservePatterns` are copied from the repository into the new
  worktree as a durable background step, using copy-on-write (`cp -c` on APFS,
  `--reflink=auto` on Linux) with a plain-copy fallback; nothing is copied without
  configured patterns
- there are no built-in preserve defaults: the `.env` family is no longer copied
  automatically — projects that relied on it must add `preservePatterns` (behavior
  change in workspace-lifecycle-v2; `excludePatterns` was removed at the same time and
  stale keys are silently ignored)
- branch publication carries the resolved project `pushRemote` as an explicit durable target;
  a successful push establishes that remote's same-named branch as upstream
- branch publication and ref freshening run as durable background steps; a failed push surfaces
  as a "branch not pushed" task state with a manual retry

- fast worktree checkout (macOS, local host only, off by default): the local host setting
  `fastWorktreeCheckout` lets the workspace registry create new worktrees by APFS-cloning
  (`clonefile(2)` via `osascript`'s ObjC bridge) a cached checkout from
  `<userData>/worktree-checkout-cache` and letting `read-tree -m -u` reconcile it, with index
  stat data rewritten so the first `git status` is fast
  (`packages/core/src/runtimes/workspace-registry/node/checkout-cache/`). It falls back to
  the stock `git worktree add` for the first worktree, other volumes, sparse checkouts,
  filter attributes (Git LFS), changed checkout settings, git < 2.42 and any error; SSH
  workspace servers never get a cache directory. Turning it off deletes the cache.
- storage cleanup (`src/core/features/storage-cleanup/`, Settings → Repository → Storage
  cleanup, off by default, app setting `storageCleanup` with per-project Inherit/Off/Custom):
  removes Orkestra-created local task worktrees after inactivity, after the task is
  done/archived, after merge, or when unchanged and settled — never with uncommitted or
  untracked files, unpushed commits (when a remote exists), open sessions, recent activity,
  outside the managed worktree roots or through symlinks. Removal is a non-forced
  `git worktree remove`; the branch, the workspace record and conversations stay, the task
  shows "Worktree cleaned up" with a recreate action. Rotated logs, media cache, traces and
  unused fast-checkout cache entries have a machine-wide retention.

## `.orkestra.json`

`.orkestra.json` stores optional shareable project settings. Supported runtime keys:

- `preservePatterns` (gitignored files deliberately carried into new worktrees; empty unless configured)
- `scripts.prepare`
- `scripts.setup`
- `scripts.run`
- `scripts.teardown`
- `shellSetup` (per-workspace override of the host-settings default; the per-project DB
  field was retired)

Base project settings are DB-backed Project Settings, not runtime `.orkestra.json` keys:

- `worktreeDirectory`
- `defaultBranch`
- `baseRemote`
- `pushRemote`
- `tmux`

Host-local project settings are stored by the workspace registry and are not written to
`.orkestra.json`:

- `env` (variables injected into new task terminals, lifecycle scripts, and TUI/ACP agent
  processes; Orkestra-owned `ORKESTRA_*` task metadata takes precedence)

Host-level defaults (`shellSetup`, `worktreeRoot`, `tmux`) live in the host-settings
runtime (`packages/core/src/runtimes/host-settings/`), stored as a JSON file in the
host's orkestra data directory and editable from the machines/system settings UI.
Precedence is per-project DB override, then host settings, then app defaults.

## Rules

- do not hardcode worktree paths; use service helpers
- use lifecycle config for repo-specific bootstrap and teardown behavior
- `scripts.prepare` is blocking and runs after the workspace exists but before task providers,
  conversations, setup scripts, or run scripts start; keep it idempotent
- `scripts.prepare`, `scripts.setup`, and `scripts.run` wait for the background artifact copy to
  settle before running, since they may consume preserved files
- `scripts.setup` and `scripts.run` are runtime-triggered after `scripts.prepare` succeeds; they do
  not block task readiness
- lifecycle scripts execute in the dedicated scripts runtime
  (`packages/core/src/runtimes/scripts/`) on the host: PTY-backed, one run per
  (workspace, script), with provenance (`activation`/`manual`/`retry`), per-run timeouts,
  and a stop verb; the workspace registry observes runs and mirrors them into durable
  lifecycle steps for the Activity timeline
- project environment variables are resolved by the workspace registry and passed explicitly to
  every launch path; exports performed by one lifecycle shell do not mutate sibling or later
  processes
- `shellSetup` runs inside each PTY before the interactive shell starts; the workspace's
  `.orkestra.json` value overrides the host-settings default. Lifecycle commands and `shellSetup`
  are opaque strings run together in the default shell selected by the host-owned runtime at
  execution time; repository authors own their portability.
- tmux wrapping has an app level default but is also project-configurable in Project Settings
  and affects PTY lifecycle behavior. It is always disabled for local Windows sessions without
  deleting the stored preference.
- `preservePatterns` never copies tracked files or `.orkestra.json`

## Multi-repository projects

- A project folder that is not a Git repository but holds repositories (`shop/api`, `shop/web`)
  is a plain directory project. Its tasks work **in place** in the project folder: there is no
  per-task worktree isolation for such projects (per-repository worktrees under one task folder
  are not implemented).
- The covered repositories are discovered from disk on every read, never stored
  (`src/core/features/project-repositories/api/discovery.ts`): folders one level down, one more
  level inside non-repository folders, initialized submodules from `.gitmodules`; dot folders,
  `node_modules`, linked worktrees (`.git` file) and symlinks leading outside the project are
  skipped. Discovery runs on the local host only; SSH projects report `unsupported` and keep
  single-repository behaviour.
- Source control addresses a nested repository with the composite workspace id
  `<workspaceId>::repo::<relativePath>`; the source-control controller resolves it only when the
  relative path is in the current discovery result. Single-repository workspaces are unaffected.
