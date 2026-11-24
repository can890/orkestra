// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/storageCleanup.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq, isNull } from 'drizzle-orm';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { kv, projects } from '@core/services/app-db/node/schema';
import type { CleanedWorktree, CleanupEntry, CleanupReport, StorageUsage } from '../api/contract';
import {
  anyCleanupPolicyEnabled,
  resolveWorktreeRules,
  type StorageCleanupSettings,
  type WorktreeCleanupRules,
} from '../api/settings';
import { loadWorktreeCandidates, settledSince, type WorktreeCandidate } from './candidates';
import { cleanupCheckoutCache, cleanupOldFiles, type FileRetentionResult } from './file-retention';
import { createCleanupGit, type CleanupGit } from './git';
import {
  branchHasOwnCommits,
  checkWorktreePath,
  currentBranch,
  defaultBranchRef,
  headCommit,
  isAncestor,
  isStrictlyInside,
  listRemotes,
  localChangesReason,
  mainCheckoutOf,
  measureDiskUsage,
  realpathOrNull,
  removeEmptyDirectory,
  removeLinkedWorktree,
  resolveManagedRoots,
  unpushedCommitCount,
} from './worktree-inspector';

export const DAY_MS = 86_400_000;
/** Son bu kadar süre içinde açılan ya da etkinlik gören worktree'lere dokunulmaz. */
export const RECENTLY_OPENED_MS = 60 * 60 * 1000;
const LAST_REPORT_KEY = 'storage-cleanup:last-report';
const CLEANED_KEY_PREFIX = 'storage-cleanup:cleaned:';
const REPORT_ENTRY_LIMIT = 500;

export type StorageCleanupPaths = {
  /** Döndürülmüş günlüklerin klasörü. */
  logsDir: string;
  /** Her zaman korunacak etkin günlük dosya adları. */
  activeLogNames: readonly string[];
  /** Saklama süresiyle temizlenen önbellek/yakalama klasörleri. */
  cacheDirs: readonly string[];
  /** Hızlı worktree checkout önbelleği. */
  checkoutCacheDir: string;
  /** Yalnızca ölçülen, asla silinmeyen ileti ekleri. */
  attachmentsDir: string;
};

export type StorageCleanupDeps = {
  db: AppDb;
  getSettings: () => Promise<StorageCleanupSettings>;
  paths: StorageCleanupPaths;
  /** Orkestra'nın worktree kökleri (varsayılan, makine ve proje geçersiz kılmaları). */
  managedWorktreeRoots: () => Promise<string[]>;
  /** Bir yol altında açık ajan/terminal oturumu sayısı; hata fırlatırsa worktree korunur. */
  countSessions: (worktreePath: string) => Promise<number>;
  /** Kaldırmadan sonra kayıt defterinin yolu yeniden gözlemlemesini ister. */
  refreshWorkspace: (workspaceId: string) => Promise<void>;
  git?: CleanupGit;
  measure?: (target: string) => Promise<number | null>;
  now?: () => number;
  logger?: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
};

export type CleanupTrigger = CleanupReport['trigger'];

type WorktreeEvaluation =
  | { remove: false; reason: string }
  | {
      remove: true;
      reason: string;
      realPath: string;
      mainCheckout: string;
      head: string | null;
      branch: string | null;
    };

const pathExists = (target: string) =>
  fs.lstat(target).then(
    () => true,
    () => false
  );
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const days = (ms: number) => Math.floor(ms / DAY_MS);

/**
 * Depolama temizliği: worktree politikaları (etkinliksizlik, durulma/arşiv, birleşme,
 * değişmemiş dal), günlük ve önbellek saklama süreleri. Kuru çalıştırma ile gerçek
 * çalıştırma aynı değerlendirmeyi kullanır; gerçek çalıştırma kaldırmadan hemen önce
 * güvenlik denetimlerini yineler. Her kaldırma nedeniyle günlüğe yazılır.
 */
export class StorageCleanupService {
  private readonly git: CleanupGit;
  private readonly measure: (target: string) => Promise<number | null>;
  private readonly now: () => number;
  private running: Promise<CleanupReport> | null = null;

  constructor(private readonly deps: StorageCleanupDeps) {
    this.git = deps.git ?? createCleanupGit();
    this.measure = deps.measure ?? measureDiskUsage;
    this.now = deps.now ?? Date.now;
  }

  /** Kuru çalıştırma: hiçbir şey silinmez, rapor saklanmaz. */
  async preview(): Promise<CleanupReport> {
    return await this.execute('preview', true);
  }

  /** Kuralları uygular. Aynı anda tek çalıştırma; süren varsa onun bitmesini bekler. */
  async run(trigger: Exclude<CleanupTrigger, 'preview'>): Promise<CleanupReport> {
    while (this.running) await this.running.catch(() => undefined);
    const promise = this.execute(trigger, false);
    this.running = promise;
    try {
      return await promise;
    } finally {
      if (this.running === promise) this.running = null;
    }
  }

  async getLastReport(): Promise<CleanupReport | null> {
    return await this.readKv<CleanupReport>(LAST_REPORT_KEY);
  }

  /** Yalnızca worktree hâlâ yoksa döner; yeniden oluşturulmuşsa eski kayıt gösterilmez. */
  async getCleanedWorktree(workspaceId: string): Promise<CleanedWorktree | null> {
    const cleaned = await this.readKv<CleanedWorktree>(`${CLEANED_KEY_PREFIX}${workspaceId}`);
    if (cleaned === null) return null;
    const [row] = await this.deps.db
      .select({ path: workspaces.path })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (row?.path && (await pathExists(row.path))) return null;
    return cleaned;
  }

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    return await this.deps.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(isNull(projects.deletedAt))
      .orderBy(projects.name);
  }

  async getUsage(): Promise<StorageUsage> {
    const roots = await resolveManagedRoots(await this.deps.managedWorktreeRoots());
    const { paths } = this.deps;
    const sum = async (targets: readonly string[]) => {
      let total = 0;
      let measured = false;
      for (const target of targets) {
        const bytes = await this.measure(target);
        if (bytes !== null) {
          total += bytes;
          measured = true;
        }
      }
      return measured || targets.length === 0 ? total : null;
    };
    const existing = async (targets: readonly string[]) => {
      const result: string[] = [];
      for (const target of targets) {
        if ((await resolveManagedRoots([target])).length > 0) result.push(target);
      }
      return result;
    };
    const cacheDirs = await existing(paths.cacheDirs);
    const [worktrees, checkoutCache, logs, caches, attachments] = await Promise.all([
      sum(roots),
      sum(await existing([paths.checkoutCacheDir])),
      sum(await existing([paths.logsDir])),
      sum(cacheDirs),
      sum(await existing([paths.attachmentsDir])),
    ]);
    return {
      measuredAt: this.now(),
      categories: [
        { category: 'worktrees', bytes: worktrees, paths: roots, neverRemoved: false },
        {
          category: 'checkoutCache',
          bytes: checkoutCache,
          paths: [paths.checkoutCacheDir],
          neverRemoved: false,
        },
        { category: 'logs', bytes: logs, paths: [paths.logsDir], neverRemoved: false },
        { category: 'caches', bytes: caches, paths: [...paths.cacheDirs], neverRemoved: false },
        {
          category: 'attachments',
          bytes: attachments,
          paths: [paths.attachmentsDir],
          neverRemoved: true,
        },
      ],
    };
  }

  private async execute(trigger: CleanupTrigger, dryRun: boolean): Promise<CleanupReport> {
    const startedAt = this.now();
    const settings = await this.deps.getSettings();
    const entries: CleanupEntry[] = [];
    // Elle tetiklenmeyen çalıştırmalar hiçbir politika açık değilse hiçbir şeye bakmaz.
    if (anyCleanupPolicyEnabled(settings)) {
      await this.cleanupWorktrees(settings, dryRun, entries);
      await this.cleanupFiles(settings, dryRun, entries);
    }
    const report: CleanupReport = {
      trigger,
      dryRun,
      startedAt,
      finishedAt: this.now(),
      entries: entries.slice(0, REPORT_ENTRY_LIMIT),
      bytes: entries.reduce(
        (total, entry) =>
          entry.outcome === 'removed' || entry.outcome === 'would-remove'
            ? total + (entry.bytes ?? 0)
            : total,
        0
      ),
      worktrees: entries.filter(
        (entry) =>
          entry.kind === 'worktree' &&
          (entry.outcome === 'removed' || entry.outcome === 'would-remove')
      ).length,
    };
    if (
      !dryRun &&
      (trigger === 'manual' ||
        entries.some((entry) => entry.outcome === 'removed' || entry.outcome === 'failed'))
    ) {
      await this.writeKv(LAST_REPORT_KEY, report);
    }
    return report;
  }

  private async cleanupWorktrees(
    settings: StorageCleanupSettings,
    dryRun: boolean,
    entries: CleanupEntry[]
  ): Promise<void> {
    const candidates = await loadWorktreeCandidates(this.deps.db);
    if (candidates.length === 0) return;
    const roots = await resolveManagedRoots(await this.deps.managedWorktreeRoots());
    for (const candidate of candidates) {
      const rules = resolveWorktreeRules(settings, candidate.projectId);
      if (rules === null) continue;
      const base = {
        kind: 'worktree' as const,
        path: candidate.path,
        workspaceId: candidate.workspaceId,
        projectId: candidate.projectId,
        projectName: candidate.projectName,
        taskIds: candidate.tasks.map((task) => task.id),
        taskName: candidate.tasks[0]?.name ?? null,
        bytes: null,
      };
      try {
        const evaluation = await this.evaluate(candidate, rules, roots);
        if (!evaluation.remove) {
          entries.push({ ...base, outcome: 'kept', reason: sentence(evaluation.reason) });
          continue;
        }
        const bytes = await this.measure(evaluation.realPath);
        if (dryRun) {
          entries.push({
            ...base,
            bytes,
            outcome: 'would-remove',
            reason: sentence(evaluation.reason),
          });
          continue;
        }
        const blocked = await this.recheck(candidate, evaluation, roots);
        if (blocked !== null) {
          entries.push({ ...base, outcome: 'kept', reason: sentence(blocked) });
          continue;
        }
        const removed = await removeLinkedWorktree(
          this.git,
          evaluation.mainCheckout,
          evaluation.realPath
        );
        if (!removed.ok) {
          entries.push({ ...base, outcome: 'failed', reason: removed.reason });
          this.deps.logger?.warn('storage cleanup could not remove a worktree', {
            workspaceId: candidate.workspaceId,
            path: evaluation.realPath,
            reason: removed.reason,
          });
          continue;
        }
        // Havuz klasörü boş kaldıysa onu da kaldır (yönetilen kökün kendisi asla).
        const pool = path.dirname(evaluation.realPath);
        if (roots.some((root) => isStrictlyInside(root, pool))) {
          await removeEmptyDirectory(pool).catch(() => false);
        }
        const removedAt = this.now();
        await this.writeKv(`${CLEANED_KEY_PREFIX}${candidate.workspaceId}`, {
          workspaceId: candidate.workspaceId,
          removedAt,
          reason: sentence(evaluation.reason),
        } satisfies CleanedWorktree);
        entries.push({ ...base, bytes, outcome: 'removed', reason: sentence(evaluation.reason) });
        // Dal ve sohbet geçmişi kalır; görev açılınca worktree yeniden oluşturulabilir.
        this.deps.logger?.info('storage cleanup removed worktree', {
          workspaceId: candidate.workspaceId,
          taskIds: base.taskIds,
          path: evaluation.realPath,
          reason: evaluation.reason,
          bytes,
        });
        await this.deps.refreshWorkspace(candidate.workspaceId).catch(() => undefined);
      } catch (error) {
        entries.push({
          ...base,
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Bir adayın kaldırılıp kaldırılmayacağı ve nedeni (kuru ve gerçek çalıştırmada aynı). */
  private async evaluate(
    candidate: WorktreeCandidate,
    rules: WorktreeCleanupRules,
    roots: readonly string[]
  ): Promise<WorktreeEvaluation> {
    const now = this.now();
    const keep = (reason: string): WorktreeEvaluation => ({ remove: false, reason });
    if (candidate.tasks.length > 1) return keep(`shared by ${candidate.tasks.length} tasks`);
    const task = candidate.tasks[0];
    if (!task) return keep('no task uses this worktree');
    if (task.pinned) return keep('task is pinned');
    if (task.agentBusy) return keep('an agent is working in this task');
    const activityAt = Math.max(task.activityAt, candidate.lastActivatedAt ?? 0);
    if (now - activityAt < RECENTLY_OPENED_MS) return keep('opened or active in the last hour');

    const safety = await checkWorktreePath({
      worktreePath: candidate.path,
      managedRoots: roots,
      repositoryPath: candidate.repositoryPath,
    });
    if (!safety.ok) return keep(safety.reason);
    const cwd = safety.realPath;
    const mainCheckout = await mainCheckoutOf(this.git, cwd);
    if (mainCheckout === null) return keep('repository could not be inspected');
    const realMain = await realpathOrNull(mainCheckout);
    if (realMain === null) return keep('repository could not be inspected');
    if (realMain === cwd) return keep('main checkout of the project');
    const branch = await currentBranch(this.git, cwd);
    if (candidate.branch !== null && branch !== candidate.branch) {
      return keep('repository or branch changed');
    }

    const settled = settledSince(task);
    const settledFor = settled === null ? null : now - Math.max(settled, task.activityAt);
    const inactive = rules.inactiveDays !== null && activityAt < now - rules.inactiveDays * DAY_MS;
    const settledDue =
      settledFor !== null && rules.settledDays !== null && settledFor >= rules.settledDays * DAY_MS;
    let reason = inactive
      ? `inactive for ${days(now - activityAt)} days`
      : `${task.archivedAt !== null ? 'archived' : 'settled'} for ${days(settledFor ?? 0)} days`;
    let eligible = inactive || settledDue;
    const notDue =
      rules.inactiveDays !== null
        ? `inactive for ${days(now - activityAt)} of ${rules.inactiveDays} days`
        : rules.settledDays !== null
          ? settledFor === null
            ? 'task is not settled or archived'
            : `settled for ${days(settledFor)} of ${rules.settledDays} days`
          : rules.onMerge
            ? 'not merged'
            : settled !== null
              ? 'has commits beyond the default branch'
              : 'task is not settled or archived';

    const unchangedApplies = rules.unchanged && settled !== null;
    const remotes = await listRemotes(this.git, cwd);
    const head = await headCommit(this.git, cwd);
    if (!eligible && (unchangedApplies || rules.onMerge)) {
      if (head === null) return keep('worktree has no commit');
      const defaultRef = await defaultBranchRef(this.git, realMain, remotes);
      if (defaultRef === null) {
        return keep(
          remotes.length === 0 ? 'project branch is unavailable' : 'default branch is unavailable'
        );
      }
      const integrated = await isAncestor(this.git, cwd, head, defaultRef.ref);
      if (integrated && unchangedApplies) {
        eligible = true;
        reason = `no commits beyond ${defaultRef.label}`;
      } else if (integrated && rules.onMerge && remotes.length > 0 && branch !== null) {
        // Yalnız kendi commit'leri olan ve hepsi varsayılan dala girmiş dallar birleşmiş sayılır.
        if ((await branchHasOwnCommits(this.git, cwd, branch)) === true) {
          eligible = true;
          reason = 'branch was merged into the default branch';
        }
      }
    }
    if (!eligible) return keep(notDue);

    // Güvenlik kuralları: tam bir `git status` yalnızca kaldırılabilir worktree için ödenir.
    const changes = await localChangesReason(this.git, cwd);
    if (changes !== null) return keep(changes);
    const unpushed = await unpushedCommitCount(this.git, cwd, remotes);
    if (unpushed === null) return keep('unpushed commits could not be inspected');
    if (unpushed > 0) {
      return keep(
        `has ${unpushed} ${unpushed === 1 ? 'commit' : 'commits'} not pushed to a remote`
      );
    }
    const sessions = await this.sessionsAt(cwd);
    if (sessions === null) return keep('running sessions could not be checked');
    if (sessions > 0) return keep('an agent or terminal session is open');
    return { remove: true, reason, realPath: cwd, mainCheckout: realMain, head, branch };
  }

  /** Kaldırmadan hemen önce: yeni etkinlik, değişiklik ya da oturum kaldırmayı iptal eder. */
  private async recheck(
    candidate: WorktreeCandidate,
    evaluation: Extract<WorktreeEvaluation, { remove: true }>,
    roots: readonly string[]
  ): Promise<string | null> {
    const latest = (await loadWorktreeCandidates(this.deps.db)).find(
      (entry) => entry.workspaceId === candidate.workspaceId
    );
    if (!latest) return 'task or worktree changed since check';
    const settings = await this.deps.getSettings();
    const rules = resolveWorktreeRules(settings, latest.projectId);
    if (rules === null) return 'settings changed since check';
    const again = await this.evaluate(latest, rules, roots);
    if (!again.remove) return again.reason;
    if (again.realPath !== evaluation.realPath) return 'worktree moved since check';
    if (again.head !== evaluation.head) return 'commit changed since check';
    if (again.branch !== evaluation.branch) return 'repository or branch changed since check';
    return null;
  }

  private async sessionsAt(worktreePath: string): Promise<number | null> {
    try {
      return await this.deps.countSessions(worktreePath);
    } catch {
      return null;
    }
  }

  private async cleanupFiles(
    settings: StorageCleanupSettings,
    dryRun: boolean,
    entries: CleanupEntry[]
  ): Promise<void> {
    const now = this.now();
    const record = (
      category: 'logs' | 'caches' | 'checkoutCache',
      result: FileRetentionResult,
      retention: number
    ) => {
      const outcome = result.failed > 0 ? 'failed' : dryRun ? 'would-remove' : 'removed';
      entries.push({
        kind: 'files',
        category,
        outcome: result.files === 0 && result.failed === 0 ? 'kept' : outcome,
        reason:
          result.files === 0 && result.failed === 0
            ? `No files older than ${retention} days`
            : `${result.files} ${result.files === 1 ? 'file' : 'files'} older than ${retention} days` +
              (result.failed > 0 ? ` (${result.failed} could not be removed)` : ''),
        files: result.files,
        bytes: result.bytes,
      });
      if (!dryRun && result.files > 0) {
        this.deps.logger?.info('storage cleanup removed expired files', {
          category,
          files: result.files,
          bytes: result.bytes,
          retentionDays: retention,
        });
      }
    };
    const { paths } = this.deps;
    if (settings.logsDays !== null) {
      const active = new Set(paths.activeLogNames);
      const result = await cleanupOldFiles({
        root: paths.logsDir,
        olderThan: now - settings.logsDays * DAY_MS,
        dryRun,
        include: (name) => /\.log(\.\d+)?$/u.test(name),
        keep: (name) => active.has(name),
      });
      record('logs', result, settings.logsDays);
    }
    if (settings.cachesDays !== null) {
      const olderThan = now - settings.cachesDays * DAY_MS;
      const total: FileRetentionResult = { files: 0, bytes: 0, failed: 0 };
      for (const root of paths.cacheDirs) {
        const result = await cleanupOldFiles({ root, olderThan, dryRun });
        total.files += result.files;
        total.bytes += result.bytes;
        total.failed += result.failed;
      }
      record('caches', total, settings.cachesDays);
      const cache = await cleanupCheckoutCache({
        cacheDir: paths.checkoutCacheDir,
        olderThan,
        dryRun,
        measure: this.measure,
      });
      record('checkoutCache', cache, settings.cachesDays);
    }
  }

  private async readKv<T>(key: string): Promise<T | null> {
    const rows = await this.deps.db
      .select({ value: kv.value })
      .from(kv)
      .where(eq(kv.key, key))
      .limit(1);
    const raw = rows[0]?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async writeKv(key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    const now = this.now();
    await this.deps.db
      .insert(kv)
      .values({ key, value: serialized, updatedAt: now })
      .onConflictDoUpdate({ target: kv.key, set: { value: serialized, updatedAt: now } });
  }
}
