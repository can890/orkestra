// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src (Workflows sayfası)
//
// İş akışları sayfası: tanımlar (kod ve adım tabanlı), çalıştırmalar, çalıştırma ayrıntısı (adım
// zaman çizelgesi, bağlı ajan sohbetleri, bekleyen sorular, duraklat/sürdür/iptal).
import { PageLayout } from '@orkestra/ui/react/patterns';
import {
  Badge,
  Button,
  Input,
  Textarea,
  toast,
  type BadgeTone,
} from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getWorkflowsClient } from '@core/features/orchestra/api/browser/workflow-client';
import type { WorkflowDefinition, WorkflowRun } from '@core/features/orchestra/api/workflow';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getCodeWorkflowsClient } from '@core/features/workflows/api/browser/client';
import type {
  CodeWorkflowDefinitionSummary,
  CodeWorkflowEntry,
  CodeWorkflowHook,
  CodeWorkflowRun,
  CodeWorkflowRunStatus,
  CodeWorkflowStatus,
  CodeWorkflowTriggerKind,
} from '@core/features/workflows/api/contract';
import { workflowsViewDef } from '@core/features/workflows/contributions/views';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import {
  useCurrentViewParams,
  useNavigate,
} from '@core/primitives/navigation/browser/navigation-hooks';
import skillText from '../skill/orkestra-workflows/SKILL.md?raw';

const POLL_MS = 2_000;

const RUN_TONE: Record<CodeWorkflowRunStatus, BadgeTone> = {
  running: 'info',
  waiting: 'warning',
  paused: 'warning',
  completed: 'success',
  stopped: 'neutral',
  skipped: 'neutral',
  cancelled: 'neutral',
};

const ENTRY_TONE: Record<CodeWorkflowEntry['status'], BadgeTone> = {
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<CodeWorkflowRunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  paused: 'Paused',
  completed: 'Completed',
  stopped: 'Stopped',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const ENTRY_LABEL: Record<CodeWorkflowEntry['status'], string> = {
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// Ham tetikleyici türü yerine gösterilen ad (Türkçe yama etiket tablosunu çevirir).
const TRIGGER_LABEL: Record<CodeWorkflowTriggerKind, string> = {
  manual: 'manual',
  schedule: 'schedule',
  webhook: 'webhook',
  issue: 'new issue',
  'pull-request': 'new pull request',
};

type RunFilter = 'needs-you' | 'running' | 'all';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function needsYou(run: CodeWorkflowRun): boolean {
  return (
    run.status === 'paused' ||
    run.entries.some((entry) => entry.kind === 'ask' && entry.status === 'waiting')
  );
}

function formatTime(at: number | null): string {
  return at ? new Date(at).toLocaleString() : '—';
}

function formatDuration(start: number, end: number | null, now: number): string {
  const seconds = Math.max(0, Math.round(((end ?? now) - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function preview(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text;
}

/** Kısa aralıkla yoklanan veri (çalıştırmalar canlı model değil, JSON dosyalarıdır). */
function usePolled<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Yükleyiciler dış değişkene bağlı değildir; ilk hâli yeterlidir.
  const [loader] = useState(() => load);
  const refresh = useCallback(async () => {
    try {
      setData(await loader());
      setError(null);
    } catch (loadError) {
      setError(message(loadError));
    }
  }, [loader]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return { data, error, refresh };
}

function openConversation(
  projectId: string,
  taskId: string,
  conversationId: string,
  go: () => void
) {
  go();
  // Görev görünümü yerleşince sohbet sekmesi açılır.
  let tries = 0;
  const attempt = () => {
    const composition = getTaskComposition(projectId, taskId);
    if (composition) {
      composition.paneLayout.open('acp-chat', { conversationId }, { preview: false });
      return;
    }
    tries += 1;
    if (tries < 20) setTimeout(attempt, 100);
  };
  setTimeout(attempt, 0);
}

export function WorkflowsPage() {
  const { params, setParams } = useCurrentViewParams(workflowsViewDef);
  const [tab, setTab] = useState<'runs' | 'definitions'>('runs');
  const settings = useAppSettingsKey('codeWorkflows');
  const status = usePolled(async () => (await getCodeWorkflowsClient()).status());
  const runs = usePolled(async () => (await getCodeWorkflowsClient()).listRuns({ limit: 300 }));
  const enabled = status.data?.enabled ?? false;

  const copySkill = async () => {
    try {
      await navigator.clipboard.writeText(skillText);
      toast.success('Authoring skill copied', {
        description:
          'Save it as SKILL.md in your agent’s skills folder, then describe the workflow you want.',
      });
    } catch (error) {
      toast.error('Could not copy the skill', { description: message(error) });
    }
  };

  const openFolder = async () => {
    const result = await (await getCodeWorkflowsClient()).openFolder();
    if (!result.ok)
      toast.error('Could not open the workflows folder', { description: result.error });
  };

  const selected = params.runId
    ? (runs.data?.find((run) => run.id === params.runId) ?? null)
    : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="h-6 shrink-0 [-webkit-app-region:drag]" />
      <div className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto px-8">
        <div className="flex w-full flex-col gap-6 py-8">
          <PageLayout.Header
            title="Workflows"
            description="Durable multi-step workflows written as code: agents, code steps, schedules, webhooks and questions to you"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void copySkill()}>
              Copy authoring skill
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void openFolder()}>
              Open workflows folder
            </Button>
            {status.data ? (
              <span className="truncate text-xs text-foreground-muted">{status.data.folder}</span>
            ) : null}
          </div>
          {status.data && !enabled ? (
            <div className="space-y-2 rounded-md border border-border p-4">
              <p className="text-sm font-medium">Workflows are off</p>
              <p className="text-xs text-foreground-muted">
                While off, nothing in the workflows folder runs. Earlier runs are kept and continue
                once you turn workflows on. Workflow files run inside Orkestra with your user's
                permissions; only add files you trust.
              </p>
              <Button
                size="sm"
                disabled={settings.isLoading || settings.isSaving}
                onClick={() => {
                  settings.update({ enabled: true });
                  setTimeout(() => void status.refresh(), 500);
                }}
              >
                Turn on workflows
              </Button>
            </div>
          ) : null}
          {selected ? (
            <RunDetail
              run={selected}
              onBack={() => setParams({ runId: undefined })}
              onChanged={() => void runs.refresh()}
            />
          ) : (
            <>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={tab === 'runs' ? 'secondary' : 'ghost'}
                  onClick={() => setTab('runs')}
                >
                  Runs
                </Button>
                <Button
                  size="sm"
                  variant={tab === 'definitions' ? 'secondary' : 'ghost'}
                  onClick={() => setTab('definitions')}
                >
                  Definitions
                </Button>
              </div>
              {tab === 'runs' ? (
                <RunsList
                  runs={runs.data ?? []}
                  error={runs.error}
                  onOpen={(runId) => setParams({ runId })}
                />
              ) : (
                <Definitions
                  status={status.data}
                  onStarted={(runId) => {
                    void runs.refresh();
                    setParams({ runId });
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Çalıştırmalar ───────────────────────────────────────────────────────────

function RunsList({
  runs,
  error,
  onOpen,
}: {
  runs: CodeWorkflowRun[];
  error: string | null;
  onOpen: (runId: string) => void;
}) {
  const [filter, setFilter] = useState<RunFilter>('needs-you');
  const [showSkipped, setShowSkipped] = useState(false);
  const visible = useMemo(
    () =>
      runs.filter((run) => {
        if (!showSkipped && run.status === 'skipped') return false;
        if (filter === 'needs-you') return needsYou(run);
        if (filter === 'running') return run.status === 'running' || run.status === 'waiting';
        return true;
      }),
    [runs, filter, showSkipped]
  );
  const counts = {
    'needs-you': runs.filter(needsYou).length,
    running: runs.filter((run) => run.status === 'running' || run.status === 'waiting').length,
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {(
          [
            // Nesne biçimi: Türkçe yama `label` alanlarını arayüz metni olarak tanır, dizi
            // demetlerindeki metinleri tanımaz.
            { value: 'needs-you', label: `Needs you (${counts['needs-you']})` },
            { value: 'running', label: `Running (${counts.running})` },
            { value: 'all', label: 'All' },
          ] as const
        ).map(({ value, label }) => (
          <Button
            key={value}
            size="xs"
            variant={filter === value ? 'secondary' : 'ghost'}
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
        <div className="ml-auto" />
        <Button size="xs" variant="ghost" onClick={() => setShowSkipped((value) => !value)}>
          {showSkipped ? 'Hide skipped runs' : 'Show skipped runs'}
        </Button>
      </div>
      {error ? <p className="text-xs text-foreground-destructive">{error}</p> : null}
      {visible.length === 0 ? (
        <p className="text-xs text-foreground-muted">No runs here.</p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {visible.map((run) => {
            const question = run.entries.find(
              (entry) => entry.kind === 'ask' && entry.status === 'waiting'
            );
            return (
              <button
                key={run.id}
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-background-secondary"
                onClick={() => onOpen(run.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{run.title ?? run.workflow}</div>
                  <div className="truncate text-xs text-foreground-muted">
                    {run.workflow} v{run.version} · {TRIGGER_LABEL[run.trigger.kind]} ·{' '}
                    {formatTime(run.createdAt)}
                    {question ? ` · Question: ${question.question?.title ?? question.name}` : ''}
                    {run.error ? ` · ${run.error}` : ''}
                  </div>
                </div>
                <Badge tone={RUN_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Çalıştırma ayrıntısı ────────────────────────────────────────────────────

function RunDetail({
  run,
  onBack,
  onChanged,
}: {
  run: CodeWorkflowRun;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { navigate } = useNavigate();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const act = async (
    work: (
      client: Awaited<ReturnType<typeof getCodeWorkflowsClient>>
    ) => Promise<{ ok: true } | { ok: false; error: string }>
  ) => {
    setBusy(true);
    try {
      const result = await work(await getCodeWorkflowsClient());
      if (!result.ok) toast.error('Workflow action failed', { description: result.error });
    } catch (error) {
      toast.error('Workflow action failed', { description: message(error) });
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const active = run.status === 'running' || run.status === 'waiting' || run.status === 'paused';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← All runs
        </Button>
        <span className="text-sm font-medium">{run.title ?? run.workflow}</span>
        <Badge tone={RUN_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>
        <div className="ml-auto flex gap-2">
          {run.status === 'running' || run.status === 'waiting' ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void act((client) => client.pause({ runId: run.id }))}
            >
              Pause
            </Button>
          ) : null}
          {run.status === 'paused' ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void act((client) => client.resume({ runId: run.id }))}
            >
              {run.pauseKind === 'user' ? 'Resume' : 'Retry failed step'}
            </Button>
          ) : null}
          {active ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void act((client) => client.cancel({ runId: run.id }))}
            >
              Cancel run
            </Button>
          ) : null}
        </div>
      </div>
      <div className="space-y-1 text-xs text-foreground-muted">
        <p>
          {run.workflow} v{run.version} · {`started by ${TRIGGER_LABEL[run.trigger.kind]}`}
          {run.trigger.detail ? ` (${run.trigger.detail})` : ''} · {formatTime(run.createdAt)}
          {run.endedAt ? ` · ended ${formatTime(run.endedAt)}` : ''}
        </p>
        <p className="truncate">Key: {run.key}</p>
        {run.nextResumeAt ? <p>{`Retries by itself at ${formatTime(run.nextResumeAt)}.`}</p> : null}
        {run.pauseKind === 'agent' ? (
          <p>The agent gave up or timed out. Check its conversation, then retry the step.</p>
        ) : null}
      </div>
      {run.error ? (
        <p className="text-xs whitespace-pre-wrap text-foreground-destructive">{run.error}</p>
      ) : null}
      {run.reason && !run.error ? <p className="text-xs">{run.reason}</p> : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-foreground-muted">Input</summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap">
          {preview(run.payload)}
        </pre>
      </details>
      {run.status === 'completed' && run.result !== undefined ? (
        <details className="text-xs" open>
          <summary className="cursor-pointer text-foreground-muted">Result</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap">
            {preview(run.result)}
          </pre>
        </details>
      ) : null}
      <div className="space-y-2">
        {run.entries.length === 0 ? (
          <p className="text-xs text-foreground-muted">No steps have started yet.</p>
        ) : null}
        {run.entries.map((entry) => (
          <EntryCard
            key={entry.name}
            run={run}
            entry={entry}
            now={now}
            busy={busy}
            onAnswer={(choice, reason) =>
              void act((client) =>
                client.answer({
                  runId: run.id,
                  name: entry.name,
                  choice,
                  ...(reason.trim() ? { reason } : {}),
                })
              )
            }
            onOpenConversation={(projectId, taskId, conversationId) =>
              openConversation(projectId, taskId, conversationId, () =>
                navigate(taskViewDef({ projectId, taskId }))
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function EntryCard({
  run,
  entry,
  now,
  busy,
  onAnswer,
  onOpenConversation,
}: {
  run: CodeWorkflowRun;
  entry: CodeWorkflowEntry;
  now: number;
  busy: boolean;
  onAnswer: (choice: string, reason: string) => void;
  onOpenConversation: (projectId: string, taskId: string, conversationId: string) => void;
}) {
  const [reason, setReason] = useState('');
  const agent = entry.agent;
  const openQuestion =
    entry.kind === 'ask' &&
    entry.status === 'waiting' &&
    entry.question &&
    run.status !== 'cancelled';
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{entry.name}</span>
        <span className="text-xs text-foreground-muted">{entry.kind}</span>
        <Badge tone={ENTRY_TONE[entry.status]}>{ENTRY_LABEL[entry.status]}</Badge>
        <span className="text-xs text-foreground-muted">
          {formatDuration(entry.startedAt, entry.endedAt, now)}
          {entry.attempts > 1 ? ` · attempt ${entry.attempts}` : ''}
          {agent?.provider ? ` · ${agent.provider}` : ''}
          {agent?.model ? ` · ${agent.model}` : ''}
          {entry.kind === 'sleep' && entry.wakeAt ? ` · until ${formatTime(entry.wakeAt)}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {agent && agent.projectId && agent.taskId
            ? agent.conversations.map((conversationId, index) => (
                <Button
                  key={conversationId}
                  size="xs"
                  variant="secondary"
                  onClick={() =>
                    onOpenConversation(agent.projectId!, agent.taskId!, conversationId)
                  }
                >
                  {agent.conversations.length > 1
                    ? `Open conversation ${index + 1}`
                    : 'Open conversation'}
                </Button>
              ))
            : null}
        </div>
      </div>
      {entry.error ? (
        <p className="text-xs whitespace-pre-wrap text-foreground-destructive">{entry.error}</p>
      ) : null}
      {entry.kind === 'ask' && entry.question ? (
        <div className="space-y-2">
          <p className="text-sm">{entry.question.title}</p>
          {entry.question.data !== undefined ? (
            <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap text-foreground-muted">
              {preview(entry.question.data)}
            </pre>
          ) : null}
          {entry.question.timeoutAt ? (
            <p className="text-xs text-foreground-muted">
              {`Times out at ${formatTime(entry.question.timeoutAt)}.`}
            </p>
          ) : null}
          {openQuestion ? (
            <div className="space-y-2">
              <Input
                value={reason}
                placeholder="Reason (optional)"
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {entry.question.choices.map((choice) => (
                  <Button
                    key={choice}
                    size="sm"
                    disabled={busy}
                    onClick={() => onAnswer(choice, reason)}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {entry.status === 'completed' && entry.kind !== 'sleep' && entry.value !== undefined ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-foreground-muted">
            {entry.kind === 'ask' ? 'Answer' : 'Result'}
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap">
            {entry.value === null && entry.kind === 'ask'
              ? 'No answer (timed out)'
              : preview(entry.value)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

// ── Tanımlar ────────────────────────────────────────────────────────────────

function Definitions({
  status,
  onStarted,
}: {
  status: CodeWorkflowStatus | null;
  onStarted: (runId: string) => void;
}) {
  const [hooks, setHooks] = useState<CodeWorkflowHook[] | null>(null);
  const showHooks = async () => {
    try {
      setHooks(await (await getCodeWorkflowsClient()).hooks());
    } catch (error) {
      toast.error('Could not read hook URLs', { description: message(error) });
    }
  };
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Workflow files</h3>
          <div className="ml-auto" />
          {status?.enabled ? (
            <Button size="xs" variant="ghost" onClick={() => void showHooks()}>
              Show hook URLs
            </Button>
          ) : null}
        </div>
        {hooks ? (
          <div className="space-y-1 rounded-md border border-border p-3 text-xs">
            <p className="text-foreground-muted">
              Each URL contains its hook's secret; share it only with the sender. The app listens on
              127.0.0.1 and the port changes when Orkestra restarts.
            </p>
            {hooks.length === 0 ? <p>No workflow defines a webhook.</p> : null}
            {hooks.map((hook) => (
              <div key={`${hook.workflow}/${hook.hook}`} className="flex items-center gap-2">
                <span className="shrink-0">
                  {hook.workflow} / {hook.hook}
                </span>
                <code className="min-w-0 truncate">{hook.url}</code>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void navigator.clipboard.writeText(hook.url)}
                >
                  Copy
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {status?.problems.map((problem) => (
          <div
            key={problem.file}
            className="rounded-md border border-border p-3 text-xs text-foreground-destructive"
          >
            <p className="font-medium">
              {problem.file}
              {problem.line ? `:${problem.line}` : ''}
            </p>
            <p className="whitespace-pre-wrap">{problem.message}</p>
          </div>
        ))}
        {status?.enabled && status.definitions.length === 0 ? (
          <p className="text-xs text-foreground-muted">
            No workflow files yet. Copy the authoring skill into your agent and describe what you
            want, or add a .ts file to the workflows folder.
          </p>
        ) : null}
        {status?.definitions.map((definition) => (
          <DefinitionCard
            key={`${definition.name}@${definition.version}`}
            definition={definition}
            onStarted={onStarted}
          />
        ))}
      </section>
      <StepWorkflowsSection />
    </div>
  );
}

function DefinitionCard({
  definition,
  onStarted,
}: {
  definition: CodeWorkflowDefinitionSummary;
  onStarted: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const result = await (
        await getCodeWorkflowsClient()
      ).start({
        workflow: definition.name,
        input,
        ...(key.trim() ? { key: key.trim() } : {}),
      });
      if (result.ok) {
        setOpen(false);
        onStarted(result.runId);
      } else {
        toast.error('Could not start the workflow', { description: result.error });
      }
    } catch (error) {
      toast.error('Could not start the workflow', { description: message(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{definition.name}</span>
        <Badge tone="neutral">v{definition.version}</Badge>
        {!definition.latest ? (
          <span className="text-xs text-foreground-muted">older version, kept for its runs</span>
        ) : null}
        <div className="ml-auto" />
        {definition.latest ? (
          <Button size="xs" variant="secondary" onClick={() => setOpen((value) => !value)}>
            Run
          </Button>
        ) : null}
      </div>
      {definition.description ? <p className="text-xs">{definition.description}</p> : null}
      <p className="truncate text-xs text-foreground-muted">{definition.file}</p>
      {definition.triggers.map((trigger) => (
        <p key={trigger.label} className="text-xs text-foreground-muted">
          {trigger.label}
          {trigger.nextAt ? ` · next ${formatTime(trigger.nextAt)}` : ''}
        </p>
      ))}
      {open ? (
        <div className="space-y-2">
          <Textarea
            value={input}
            rows={4}
            placeholder='Input as JSON, for example {"name": "v1.4"} (empty for null)'
            onChange={(event) => setInput(event.target.value)}
          />
          <Input
            value={key}
            placeholder="Key (optional; the same key returns the same run)"
            onChange={(event) => setKey(event.target.value)}
          />
          <Button size="sm" disabled={busy} onClick={() => void start()}>
            Start run
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Mevcut adım tabanlı (Orkestra modu) iş akışları aynı sayfada listelenir. */
function StepWorkflowsSection() {
  const openEditor = useOpenModal('workflowEditorModal');
  const openRun = useOpenModal('workflowRunModal');
  const definitions = usePolled<WorkflowDefinition[]>(async () =>
    (await getWorkflowsClient()).list()
  );
  const runs = usePolled<WorkflowRun[]>(async () => (await getWorkflowsClient()).listRuns({}));
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Step workflows</h3>
        <div className="ml-auto" />
        <Button size="xs" variant="ghost" onClick={() => void openEditor({ workflowId: null })}>
          New step workflow
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        Prompt chains run by Orkestra mode inside a task. Start one from a task: New conversation →
        Orkestra → Mode: Workflow.
      </p>
      {(definitions.data ?? []).map((definition) => {
        const recent = (runs.data ?? [])
          .filter((run) => run.workflowId === definition.id)
          .slice(-3)
          .reverse();
        return (
          <div key={definition.id} className="space-y-1 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{definition.name}</span>
              <span className="text-xs text-foreground-muted">{definition.steps.length} steps</span>
              <div className="ml-auto" />
              <Button
                size="xs"
                variant="secondary"
                onClick={() => void openEditor({ workflowId: definition.id })}
              >
                Edit
              </Button>
            </div>
            {recent.map((run) => (
              <button
                key={run.id}
                type="button"
                className="block w-full truncate text-left text-xs text-foreground-muted hover:text-foreground"
                onClick={() => void openRun({ runId: run.id })}
              >
                {formatTime(run.createdAt)} · {run.status}
              </button>
            ))}
          </div>
        );
      })}
    </section>
  );
}
