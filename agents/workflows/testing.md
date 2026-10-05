# Testing And Validation

All paths are relative to `apps/orkestra-desktop/`.

## Core Local Gate

Run these before merging (from the repo root or `apps/orkestra-desktop/`):

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm run test
```

## Test Commands

`pnpm test` at the repository root runs every package's default test suite.
Inside an app or package directory it runs only that package's suite. From the
root, `pnpm --filter @orkestra/plugins test` runs only the selected package's suite.
All three routes use Nx to prepare required builds automatically; dependency
builds do not cause dependency tests to run. Nx is installed by `pnpm install`.

Pass test-file paths or Vitest options after `test --`, for example
`pnpm --filter @orkestra/orkestra-desktop test -- --project scripts`. The separator
prevents Nx from consuming flags that both tools recognize, such as `--project`.
Direct `pnpm exec vitest` is an advanced debugging escape hatch that bypasses
prerequisite preparation.

Existing suite boundaries remain unchanged: fixture generation, performance
measurements, benchmarks, and the opt-in remote integration flow remain explicit
commands. Specialized test commands also prepare prerequisite builds. Watch and
other specialized test targets do not cache their results, while their builds
can use the Nx cache.

## Test Layout

- main-process tests: colocated in `src/main/core/**/*.test.ts`
- renderer unit tests: `src/renderer/tests/`
- renderer browser tests: `src/renderer/tests/browser/` (run via Playwright)

## Current Setup

- Vitest config is in `vitest.config.ts` (separate from the build config in `electron.vite.config.ts`).
- Six test projects:
  - `node` — `src/**/*.test.ts` excluding `_*` dirs, browser tests, migration tests, `*.db.test.ts`, and `src/main/db/legacy-port/**/*.test.ts`
  - `main-db` — `src/main/core/**/*.db.test.ts` and `src/main/db/legacy-port/**/*.test.ts` against real SQLite
  - `fixtures` — fixture generator, run via `pnpm run db:fixtures`
  - `migrations` — `src/main/db/tests/migrations/**`, run via `pnpm run test:migrations`
  - `scripts` — release, support, and developer-command tests under `scripts/`
  - `browser` — `src/renderer/tests/browser/**/*.test.{ts,tsx}` via Playwright
- `pnpm run test` runs every project except `fixtures` (`node`, `main-db`,
  `migrations`, `scripts`, and `browser`). Setting `ORKESTRA_TEST_SKIP_BROWSER=1`
  omits the Playwright-backed `browser` project locally; CI omits it automatically.
- Tests use per-file `vi.mock()` setup.
- Integration-style tests create temporary repos and worktrees in `os.tmpdir()`.

## CI Notes

- `.github/workflows/code-consistency-check.yml` runs on pull requests to `main`,
  pushes to `main`, and manual `workflow_dispatch` runs. A newer run on the same
  ref cancels the one in progress.
- Its matrix uses `nx affected` to enforce format:check, typecheck, lint, and test
  only for touched projects and their dependents. `nrwl/nx-set-shas` picks the
  base: the merge base with `main` for pull requests, and the commit of the last
  successful push run on `main` for pushes, so changes from failed or cancelled
  runs are checked again. Manual runs, and pushes with no earlier successful push
  run (first run, rewritten history), use `nx run-many --all` instead.
- On pushes and manual runs, the `build-desktop` job smoke-tests
  `pnpm nx build @orkestra/orkestra-desktop` (workspace packages first, then
  `electron-vite build` and the localization patch) and checks that `out/` holds
  the main entry, the renderer HTML, and the plugin adapters. A bare
  `pnpm run build` in the app directory skips the package builds and fails on a
  clean checkout.
- CI installs with `--ignore-scripts`. The desktop build needs no lifecycle
  scripts because electron-vite externalizes the native modules. For tests, the
  workflow explicitly installs the native side project
  (`pnpm --dir apps/orkestra-desktop/tooling/node-deps install`) for the
  DB-backed Vitest projects. It also rebuilds and load-checks `node-pty`
  from `@orkestra/core`, a workspace that declares the dependency. Vitest omits the
  Playwright-backed `browser` projects (app and chat-ui) when it detects CI until
  browser provisioning is proven stable there.
- The full suite (including `browser` projects) is still expected locally before merging.

## Focused Validation

- after IPC/RPC changes: rerun the affected Vitest file and confirm the controller is wired in `src/main/rpc.ts`
- after worktree or PTY changes: rerun the closest `src/main/core/` test files
- after schema changes: run `pnpm run db:fixtures` and `pnpm run test:migrations`
