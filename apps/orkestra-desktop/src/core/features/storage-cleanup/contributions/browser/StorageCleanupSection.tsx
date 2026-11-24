import { SettingsCard, SettingsRow } from '@orkestra/ui/react/patterns';
import { Button, Dialog, Select, Switch, toast } from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getStorageCleanupClient } from '../../api/browser/client';
import type {
  CleanupEntry,
  CleanupReport,
  StorageCategory,
  StorageUsage,
} from '../../api/contract';
import {
  DEFAULT_STORAGE_CLEANUP_SETTINGS,
  DISABLED_WORKTREE_RULES,
  type ProjectCleanupOverride,
  type StorageCleanupSettings,
  type WorktreeCleanupRules,
} from '../../api/settings';

const CATEGORY_LABELS: Record<StorageCategory, string> = {
  worktrees: 'Task worktrees',
  checkoutCache: 'Fast checkout cache',
  logs: 'Logs',
  caches: 'Media cache and traces',
  attachments: 'Message attachments',
};

const OFF = 'off';
const INACTIVE_DAYS = [3, 7, 14, 30, 60, 90];
const SETTLED_DAYS = [0, 1, 3, 7, 14, 30];
const RETENTION_DAYS = [7, 14, 30, 90];

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function DaysSelect({
  value,
  options,
  zeroLabel,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: number | null;
  options: readonly number[];
  zeroLabel?: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: number | null) => void;
}) {
  const label = (days: number | null) =>
    days === null ? 'Off' : days === 0 && zeroLabel ? zeroLabel : `${days} days`;
  const choices = value === null || options.includes(value) ? options : [...options, value];
  return (
    <Select.Root
      value={value === null ? OFF : String(value)}
      disabled={disabled}
      onValueChange={(next) => onChange(next === OFF || next === null ? null : Number(next))}
    >
      <Select.Trigger className="w-[160px] shrink-0" aria-label={ariaLabel}>
        <Select.Value>{label(value)}</Select.Value>
      </Select.Trigger>
      <Select.Content align="end">
        <Select.Item value={OFF}>Off</Select.Item>
        {choices.map((days) => (
          <Select.Item key={days} value={String(days)}>
            {label(days)}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function WorktreeRulesRows({
  rules,
  disabled,
  onChange,
}: {
  rules: WorktreeCleanupRules;
  disabled: boolean;
  onChange: (next: WorktreeCleanupRules) => void;
}) {
  return (
    <>
      <SettingsRow
        label="Remove inactive worktrees"
        description="Remove a task's worktree when the task has had no activity for this long."
        control={
          <DaysSelect
            ariaLabel="Remove inactive worktrees"
            value={rules.inactiveDays}
            options={INACTIVE_DAYS}
            disabled={disabled}
            onChange={(inactiveDays) => onChange({ ...rules, inactiveDays })}
          />
        }
      />
      <SettingsRow
        label="Remove after a task is done or archived"
        description="Remove the worktree once its task has been done, cancelled or archived for this long."
        control={
          <DaysSelect
            ariaLabel="Remove after a task is done or archived"
            value={rules.settledDays}
            options={SETTLED_DAYS}
            zeroLabel="Next cleanup"
            disabled={disabled}
            onChange={(settledDays) => onChange({ ...rules, settledDays })}
          />
        }
      />
      <SettingsRow
        label="Remove merged worktrees"
        description="Remove the worktree when all of its branch's commits are on the default branch."
        control={
          <Switch
            aria-label="Remove merged worktrees"
            checked={rules.onMerge}
            disabled={disabled}
            onCheckedChange={(onMerge) => onChange({ ...rules, onMerge })}
          />
        }
      />
      <SettingsRow
        label="Remove unchanged worktrees"
        description="Remove the worktree of a done or archived task that has no commits beyond the default branch."
        control={
          <Switch
            aria-label="Remove unchanged worktrees"
            checked={rules.unchanged}
            disabled={disabled}
            onCheckedChange={(unchanged) => onChange({ ...rules, unchanged })}
          />
        }
      />
    </>
  );
}

function outcomeLabel(entry: CleanupEntry): string {
  switch (entry.outcome) {
    case 'removed':
      return 'Removed';
    case 'would-remove':
      return 'Would remove';
    case 'failed':
      return 'Failed';
    default:
      return 'Kept';
  }
}

function ReportView({ report }: { report: CleanupReport }) {
  const [showKept, setShowKept] = useState(false);
  const active = report.entries.filter((entry) => entry.outcome !== 'kept');
  const kept = report.entries.filter((entry) => entry.outcome === 'kept');
  const describe = (entry: CleanupEntry) =>
    entry.kind === 'worktree'
      ? `${entry.taskName ?? entry.path} · ${entry.projectName}`
      : CATEGORY_LABELS[entry.category];
  const row = (entry: CleanupEntry, index: number) => (
    <li key={index} className="flex items-start justify-between gap-3 py-1 text-xs">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-foreground">{describe(entry)}</span>
        <span className="text-foreground-muted">{entry.reason}</span>
        {entry.kind === 'worktree' ? (
          <span className="truncate font-mono text-[11px] text-foreground-passive">
            {entry.path}
          </span>
        ) : null}
      </div>
      <span className="shrink-0 text-foreground-muted">
        {outcomeLabel(entry)}
        {entry.bytes ? ` · ${formatBytes(entry.bytes)}` : ''}
      </span>
    </li>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm text-foreground">
        {report.dryRun
          ? `${report.worktrees} worktrees, ${formatBytes(report.bytes)} in total would be removed.`
          : `${report.worktrees} worktrees, ${formatBytes(report.bytes)} in total were removed.`}
      </div>
      {active.length > 0 ? <ul className="divide-y divide-border/60">{active.map(row)}</ul> : null}
      {kept.length > 0 ? (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowKept((value) => !value)}>
            {showKept ? 'Hide kept worktrees' : `Show kept worktrees (${kept.length})`}
          </Button>
          {showKept ? <ul className="divide-y divide-border/60">{kept.map(row)}</ul> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ayarlar → Repository → Worktrees altındaki depolama temizliği bölümü: kategori başına
 * disk kullanımı, makine politikaları, proje geçersiz kılmaları, kuru çalıştırma önizlemesi
 * ve onaylı "Clean now".
 */
export function StorageCleanupSection() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('storageCleanup');
  const settings: StorageCleanupSettings = value ?? DEFAULT_STORAGE_CLEANUP_SETTINGS;
  const busy = isLoading || isSaving;
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [working, setWorking] = useState<'preview' | 'clean' | null>(null);
  const [confirm, setConfirm] = useState<CleanupReport | null>(null);

  const measure = useCallback(async () => {
    setMeasuring(true);
    try {
      setUsage(await (await getStorageCleanupClient()).getUsage());
    } catch (error) {
      toast.error('Could not measure disk usage', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setMeasuring(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const client = await getStorageCleanupClient();
      setProjects(await client.listProjects());
      setReport(await client.getLastReport());
    })().catch(() => undefined);
    void measure();
  }, [measure]);

  const save = (patch: Partial<StorageCleanupSettings>) => {
    update(patch);
  };

  const runPreview = async (): Promise<CleanupReport | null> => {
    setWorking('preview');
    try {
      const next = await (await getStorageCleanupClient()).preview();
      setReport(next);
      return next;
    } catch (error) {
      toast.error('Could not preview the cleanup', {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      setWorking(null);
    }
  };

  const cleanNow = async () => {
    setConfirm(null);
    setWorking('clean');
    try {
      const next = await (await getStorageCleanupClient()).runNow();
      setReport(next);
      toast.success('Storage cleanup finished', {
        description: `${next.worktrees} worktrees, ${formatBytes(next.bytes)} removed.`,
      });
      void measure();
    } catch (error) {
      toast.error('Storage cleanup failed', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setWorking(null);
    }
  };

  const override: ProjectCleanupOverride | undefined = selectedProject
    ? settings.projectOverrides[selectedProject]
    : undefined;
  const setOverride = (projectId: string, next: ProjectCleanupOverride | null) => {
    const projectOverrides = { ...settings.projectOverrides };
    if (next === null) delete projectOverrides[projectId];
    else projectOverrides[projectId] = next;
    save({ projectOverrides });
  };
  const selectedName = projects.find((project) => project.id === selectedProject)?.name;

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-foreground">Disk usage on this machine</div>
          <Button size="sm" variant="ghost" disabled={measuring} onClick={() => void measure()}>
            {measuring ? 'Measuring…' : 'Refresh'}
          </Button>
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          {(usage?.categories ?? []).map((entry) => (
            <li key={entry.category} className="flex justify-between text-xs">
              <span className="text-foreground-muted">
                {CATEGORY_LABELS[entry.category]}
                {entry.neverRemoved ? ' (never removed)' : ''}
              </span>
              <span className="text-foreground">{formatBytes(entry.bytes)}</span>
            </li>
          ))}
          {usage === null ? (
            <li className="text-xs text-foreground-muted">
              {measuring ? 'Measuring…' : 'Not measured yet'}
            </li>
          ) : null}
        </ul>
      </SettingsCard>

      <SettingsCard>
        <div className="mb-2 text-xs text-foreground-muted">
          Automatic cleanup runs on this machine at startup, when these rules change and every hour.
          Everything is off by default. A worktree is never removed while it has uncommitted changes
          or untracked files, commits that are not pushed to a remote, an open agent or terminal
          session, or was opened in the last hour. Only worktrees Orkestra created in its worktree
          folders are removed, with git worktree remove; the branch and the task&apos;s conversation
          history are kept, and the worktree can be recreated from the task.
        </div>
        <WorktreeRulesRows
          rules={settings.worktrees}
          disabled={busy}
          onChange={(worktrees) => save({ worktrees })}
        />
        <SettingsRow
          label="Delete old logs"
          description="Delete rotated log files older than this. The current log is always kept."
          control={
            <DaysSelect
              ariaLabel="Delete old logs"
              value={settings.logsDays}
              options={RETENTION_DAYS}
              disabled={busy}
              onChange={(logsDays) => save({ logsDays })}
            />
          }
        />
        <SettingsRow
          label="Delete old caches and captures"
          description="Delete cached mobile media, performance traces and unused fast checkout cache entries older than this. Message attachments and browser profiles are kept."
          control={
            <DaysSelect
              ariaLabel="Delete old caches and captures"
              value={settings.cachesDays}
              options={RETENTION_DAYS}
              disabled={busy}
              onChange={(cachesDays) => save({ cachesDays })}
            />
          }
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          label="Project override"
          description="Choose a project to follow this machine's worktree rules (Inherit), keep its worktrees (Off) or use its own rules (Custom). Log and cache retention stays machine-wide."
          control={
            <Select.Root
              value={selectedProject ?? ''}
              onValueChange={(next) => setSelectedProject(next ? String(next) : null)}
            >
              <Select.Trigger className="w-[200px] shrink-0" aria-label="Project">
                <Select.Value>{selectedName ?? 'Choose a project'}</Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                {projects.map((project) => (
                  <Select.Item key={project.id} value={project.id}>
                    {project.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          }
        />
        {selectedProject ? (
          <>
            <SettingsRow
              label="Automatic worktree cleanup"
              description={`Worktree cleanup for ${selectedName ?? 'this project'}.`}
              control={
                <Select.Root
                  value={override?.mode ?? 'inherit'}
                  disabled={busy}
                  onValueChange={(mode) => {
                    if (mode === 'off') setOverride(selectedProject, { mode: 'off' });
                    else if (mode === 'custom') {
                      setOverride(selectedProject, {
                        mode: 'custom',
                        rules: override?.mode === 'custom' ? override.rules : settings.worktrees,
                      });
                    } else setOverride(selectedProject, null);
                  }}
                >
                  <Select.Trigger
                    className="w-[160px] shrink-0"
                    aria-label="Automatic worktree cleanup"
                  >
                    <Select.Value>
                      {override?.mode === 'off'
                        ? 'Off'
                        : override?.mode === 'custom'
                          ? 'Custom'
                          : 'Inherit'}
                    </Select.Value>
                  </Select.Trigger>
                  <Select.Content align="end">
                    <Select.Item value="inherit">Inherit</Select.Item>
                    <Select.Item value="off">Off</Select.Item>
                    <Select.Item value="custom">Custom</Select.Item>
                  </Select.Content>
                </Select.Root>
              }
            />
            {override?.mode === 'custom' ? (
              <WorktreeRulesRows
                rules={override.rules ?? DISABLED_WORKTREE_RULES}
                disabled={busy}
                onChange={(rules) => setOverride(selectedProject, { mode: 'custom', rules })}
              />
            ) : null}
          </>
        ) : null}
      </SettingsCard>

      <SettingsCard>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={working !== null}
            onClick={() => void runPreview()}
          >
            {working === 'preview' ? 'Checking…' : 'Preview cleanup'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            tone="destructive"
            disabled={working !== null}
            onClick={() => {
              void runPreview().then((next) => {
                if (next) setConfirm(next);
              });
            }}
          >
            {working === 'clean' ? 'Cleaning…' : 'Clean now'}
          </Button>
        </div>
        {report ? (
          <div className="mt-3">
            <div className="mb-1 text-xs text-foreground-passive">
              {report.dryRun ? 'Preview' : 'Latest cleanup'} ·{' '}
              {new Date(report.finishedAt).toLocaleString()}
            </div>
            <ReportView report={report} />
          </div>
        ) : null}
      </SettingsCard>

      <Dialog.Root
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <Dialog.Content size="md">
          <Dialog.Header>
            <Dialog.Title>Clean up storage now?</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Dialog.Description>
              {confirm && confirm.entries.some((entry) => entry.outcome === 'would-remove')
                ? `${confirm.worktrees} worktrees and expired files, about ${formatBytes(confirm.bytes)}, will be removed. Branches and task conversations are kept. Each item is checked again right before it is removed.`
                : 'Nothing matches the enabled rules right now.'}
            </Dialog.Description>
            {confirm ? (
              <div className="mt-3 max-h-64 overflow-auto">
                <ReportView report={confirm} />
              </div>
            ) : null}
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close render={<Button variant="ghost">Cancel</Button>} />
            <Button
              variant="primary"
              tone="destructive"
              disabled={!confirm?.entries.some((entry) => entry.outcome === 'would-remove')}
              onClick={() => void cleanNow()}
            >
              Clean now
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
