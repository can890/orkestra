---
name: orkestra-workflows
description: Author, edit, run, and debug durable Orkestra workflows (`~/.orkestra/workflows/*.ts`). Use when asked to build or change a multi-step Orkestra automation that ties together agent conversations, plain code steps, schedules, webhooks, new issues or pull requests, and questions to the user, or to inspect, resume, answer, or cancel workflow runs.
---

<!-- Adapted from the T3 Code workflows skill (MIT, © 2026 T3 Tools Inc.). -->

# Orkestra workflows

A workflow is a TypeScript file that the Orkestra desktop app runs durably. Every named step's
result is saved the moment it succeeds, so an app restart continues the run from the first
unfinished step, and a failing step pauses the run instead of losing earlier work. Runs can sleep
for days, ask the user a question and wait for the answer, and run agents in real Orkestra
conversations.

Use a workflow for multi-stage work that must not be lost or repeated (triage → fix → approval,
nightly reports, webhook reactions). For one prompt on a timer, an Orkestra automation is simpler.

## Quick start

Workflows are off by default. If the Workflows page says they are off, ask the user to turn them on
in **Settings → General → Workflows**; do not edit their settings yourself.

Put a `.ts` (or `.mts`, `.mjs`, `.js` as ES module) file in `~/.orkestra/workflows/` (or the folder
or single file named by the `ORKESTRA_WORKFLOWS` environment variable). The app watches the folder
and reloads changed files by itself. File names use letters, digits, `-`, `_` and `.`; other names,
dot-files and subfolders are skipped. Files run with Node's type stripping, so only erasable
TypeScript works: no `enum`, `namespace`, or parameter properties.

Workflow files import nothing from Orkestra. A single global, `Orkestra`, holds the whole API; take
what you use at the top of the file. Node built-ins (`node:fs`, `node:child_process`) and relative
`.mjs` helpers in a subfolder can be imported normally (restart the app after changing a helper).

```ts
const { workflow, step, agent, ask, stop, title, daily, z } = Orkestra;

export default workflow(
  'dependency-report',
  { version: 1, payload: Orkestra.Tick, triggers: [daily('09:00', { weekdays: [1, 2, 3, 4, 5] })] },
  async (tick) => {
    title(`Dependencies ${tick.scheduledAt.slice(0, 10)}`);

    const audit = await agent('audit', {
      task: 'TASK_ID', // id of an existing Orkestra task (its worktree is where the agent works)
      provider: 'claude',
      brief: "List this repository's outdated dependencies. Do not change any file.",
      returns: z.object({ outdated: z.array(z.object({ name: z.string(), latest: z.string() })) }),
    });
    if (audit.value.outdated.length === 0) return stop('nothing is outdated');

    const answer = await ask('approve-upgrade', {
      title: `Upgrade ${audit.value.outdated.length} dependencies?`,
      choices: ['upgrade', 'skip'],
      data: audit.value,
      timeout: '2 days',
    });
    if (!answer || answer.choice === 'skip') return stop('not approved');

    await agent('upgrade', {
      conversation: audit.conversation,
      brief: 'Upgrade the dependencies you listed, run the tests, and say what changed.',
    });
  }
);
```

### What `Orkestra` holds

- **Definition & body**: `workflow`, `step`, `step.try`, `agent`, `agent.try`, `ask`, `sleep`,
  `title`, `stop`, `skip`
- **Triggers**: `every`, `daily`, `cron`, `webhook`, `issues.opened`, `pullRequests.opened`
- **Schemas**: `z` (zod), `Tick`, `WebhookRequest`, `Issue`, `PullRequest`

A bare `step(…)` without taking it from `Orkestra` first is a `ReferenceError`.

## Defining a workflow

`workflow(name, options, body)` registers a workflow. Call it at the top level of the file (or
`export default` what it returns, or a list of them). Each `(name, version)` pair must be unique
across all files.

| Option        | Required | Meaning                                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `version`     | Yes      | Integer ≥ 1. Raise it whenever the body changes (see the rules below).                           |
| `payload`     | No       | `z` schema of the run's input. Starts with input that does not fit are refused.                  |
| `returns`     | No       | `z` schema of the body's return value.                                                           |
| `description` | No       | Shown on the Workflows page.                                                                     |
| `triggers`    | No       | Triggers that start runs by themselves.                                                          |
| `resumeAfter` | No       | Waits before auto-resuming a run paused by a failed code step. Default `['5 minutes', '20 minutes', '80 minutes']`. Checked about every 15 seconds. |

The body is `async (payload, run) => { … }`, where `run.id` is the run's id. `await` every
primitive.

## Body primitives

Every named primitive stores its result under its name, which must be unique across all primitives
in the run (a `step('fix', …)` and an `agent('fix', …)` collide).

| Call                                     | Behavior                                                                       | Returns                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `step(name, fn, { returns?, retry? })`   | Runs `fn({ signal, attempt })` once per run and saves its JSON result. Failure pauses the run. | the value                                       |
| `step.try(name, fn, options?)`           | Same, but returns failure as data instead of pausing.                          | `{ outcome: 'done', value }` or `{ outcome: 'failed', reason }` |
| `agent(name, options)`                   | Runs an agent in a real Orkestra conversation. Failure pauses the run for you. | `{ value, conversation }`                                     |
| `agent.try(name, options)`               | Same, but returns failure as data.                                             | `{ outcome: 'done', value, conversation }` or `{ outcome: 'failed', reason, conversation }` |
| `ask(name, { title, choices, data?, timeout? })` | Puts a multiple-choice question to the user (notification + Workflows page) and waits durably. | `{ choice, reason? }` or `null` on timeout |
| `sleep(name, duration)`                  | Durable sleep across restarts (`'1 hour'`, `'2 days'`).                        | `undefined`                                                   |
| `title(text)`                            | Sets the run's display title (cut to 200 characters). No name.                 | `undefined`                                                   |
| `stop(reason)`                           | Ends the run on purpose as `stopped`. Use `return stop(…)`.                    | never                                                         |
| `skip(reason)`                           | Ends the run as `skipped`.                                                     | never                                                         |

- **Retries:** a `step` runs once by default. For idempotent work pass
  `retry: { times: 3, delay: '2 seconds' }` (without `delay`, waits double from one second).
- **Inside a step** only plain code runs: calling `step`, `agent`, `ask`, `sleep`, `title`, `stop` or
  `skip` there fails the step.
- **Never catch errors from primitives.** Waiting and failing work by interrupting the body; a
  `try/catch` around a primitive does not stop that, it only hides your own mistakes. Use
  `step.try` / `agent.try` to branch on failure.
- **Parallel work:** `await Promise.all([agent('a', …), agent('b', …)])`. Use separate tasks
  (worktrees) when two agents may edit the same files.
- **Durations** are milliseconds or text: `'30 seconds'`, `'5 minutes'`, `'2 hours'`, `'1 day'`.
- **Strict options:** every call refuses an option it does not take and names the ones it does.

## Agents (`agent` and `agent.try`)

| Option         | Applies to   | Meaning                                                                                      |
| -------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `brief`        | All          | Full instructions. The agent sees only this brief and the task's worktree.                   |
| `task`         | New          | Id of an existing Orkestra task; the conversation opens in that task.                        |
| `provider`     | New          | Agent provider id such as `'claude'`, `'codex'`, `'gemini'` (must support ACP).             |
| `model`        | New          | Model id or name offered by the provider; the step fails if it cannot be applied.            |
| `conversation` | Continue     | `conversation` returned by an earlier agent step; continues that conversation.               |
| `returns`      | All          | `z` schema. The agent is asked to end with a fenced `json` block; up to 2 correction prompts. |
| `timeout`      | All          | Time limit for the turn; past it the turn is stopped and the step fails.                     |
| `title`        | New          | Conversation title. Defaults to `<workflow>: <step>`.                                        |
| `autoApprove`  | New          | Answer the agent's permission requests automatically (default `false`: you approve them in the conversation). |

- The conversation is an ordinary Orkestra conversation: open it from the run page to watch it,
  approve permissions, or steer the agent.
- A turn that dies (the session was cut off) is retried once in a fresh conversation. An agent that
  ran and failed or timed out pauses the run until you resume it; `resumeAfter` does not apply. An
  agent that could not be started (no such task or provider) pauses like a failed code step.
- After an app restart an unfinished agent step starts again in a new conversation.

## Questions (`ask`)

`ask` shows a notification and an answer form on the run's page; the run waits (also across
restarts) until the user picks a choice, optionally with a reason. With `timeout`, `null` comes back
when nobody answered in time. Always handle `null`.

## Triggers

A workflow's `payload` schema must match what its triggers send.

| Trigger                                             | Payload          | Notes                                                                                                  |
| --------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `every('1 hour')`                                   | `Tick`           | `{ scheduledAt }`. At least one minute. First run one interval after load; downtime collapses to one run. |
| `daily('09:00', { weekdays?: [1,2,3,4,5] })`        | `Tick`           | Local time, `0` is Sunday. A time missed by more than 10 minutes is skipped.                            |
| `cron('0 9 * * 1-5', { tz? })`                      | `Tick`           | Five-field cron, same syntax as Orkestra automations; local time zone unless `tz` is given.            |
| `webhook('name', { key?, signature? })`             | `WebhookRequest` | `{ method, headers, query, body }` (lower-case header names, text body). See below.                    |
| `issues.opened({ project, provider? })`             | `Issue`          | Polls the project's connected issue tracker about once a minute (`provider` defaults to `'github'`). Only issues opened after the workflow first loaded start runs. |
| `pullRequests.opened({ project })`                  | `PullRequest`    | Polls the project's git host about once a minute; only pull requests opened after first load.          |

`project` is the Orkestra project id. Filter unwanted deliveries in the body with
`return skip('not a push to main')`.

### Webhooks

The Workflows page lists each hook's URL (Definitions → Show hook URLs). The URL contains the hook's
secret: share it only with the sender. The app listens on `127.0.0.1` with a port chosen at start-up,
so senders on other machines need a tunnel, and the URL changes when the app restarts.

- A retry that repeats a delivery header (`X-GitHub-Delivery`, `Idempotency-Key`, `webhook-id`, the
  GitLab, Gitea and Linear ones) starts no second run; for other senders `key: (request) => …`
  names the run from the request.
- `signature: { header: 'X-Hub-Signature-256', prefix: 'sha256=' }` checks an HMAC-SHA256 of the
  body made with the hook secret (the last part of the URL) — set the sender's webhook secret to it.
- Bodies over 1 MiB are refused; a hook starts at most 60 runs a minute (`429` after that).

## Starting, pausing, resuming

- **Manual:** Workflows page → Definitions → Run, with JSON input and an optional key. Starting twice
  with the same key returns the same run.
- **Pause** lets the steps that are running finish, then holds the run. **Resume** continues a
  paused run; only the failed step runs again. **Cancel** stops active agent turns; a cancelled run
  cannot be resumed.
- Run states: `running`, `waiting` (question or sleep), `paused`, `completed`, `stopped`, `skipped`,
  `cancelled`.

## Rules you must not break

1. **The body is replayed from the top.** After every wait or restart the body runs again and
   completed primitives return their saved values. Put all side effects, I/O, clock reads and
   randomness inside `step` or `agent`. Code between primitives must be deterministic given the
   payload and earlier results.
2. **Names are journal keys.** Every named primitive needs a unique name within the run. Loops need
   distinct names (`` step(`check-${i}`, …) ``).
3. **Bump `version` when changing a live workflow.** Do not reorder, rename, or change the kind of
   steps in a version that still has unfinished runs. Add the new body under a higher `version` and
   keep the old one in the file until its runs end. New runs use the highest version. A run whose
   version is no longer loaded pauses until it is restored.
4. **Results must be JSON.** Everything saved is stored as JSON; a value that does not fit its
   `returns` schema fails the step.
5. **Steps can run more than once.** A crash mid-step, a retry or a resume runs the step again. Make
   external side effects idempotent (derive keys from the payload or `run.id`, one comment or post
   per step).

## Safety

Workflow files run inside the Orkestra app with your user's permissions, without a sandbox, like any
script you run yourself. Only put files you trust in the workflows folder. While workflows are off,
nothing in the folder is loaded or run.

## Files and errors

If an edited file fails to load, its last working version keeps running and the Workflows page shows
the file, the message and (when known) the line. A file that defines a `(name, version)` already
defined in another file is refused the same way. Mistakes inside a body surface when a run reaches
them: the run pauses with the error, and you resume it after fixing the file (bump the version if
steps changed).
