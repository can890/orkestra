import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import type { WorkspaceConfig } from '@core/primitives/workspaces/api';
import { projects, tasks } from '@core/services/app-db/node/schema';
import {
  DEFAULT_STORAGE_CLEANUP_SETTINGS,
  DISABLED_WORKTREE_RULES,
  type StorageCleanupSettings,
  type WorktreeCleanupRules,
} from '../api/settings';
import { createCleanupGit } from './git';
import { DAY_MS, StorageCleanupService } from './storage-cleanup-service';

// Depolama temizliği uçtan uca: geçici git depoları + geçici uygulama veritabanı ve veri
// klasörleri. Her politika, her güvenlik kuralı, kuru çalıştırma = gerçek çalıştırma.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function rules(overrides: Partial<WorktreeCleanupRules>): StorageCleanupSettings {
  return {
    ...DEFAULT_STORAGE_CLEANUP_SETTINGS,
    worktrees: { ...DISABLED_WORKTREE_RULES, ...overrides },
  };
}

describe('StorageCleanupService', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let root: string;
  let managedRoot: string;
  let repo: string;
  let origin: string;
  let dataDir: string;
  let settings: StorageCleanupSettings;
  let sessions: (worktreePath: string) => Promise<number>;
  let refreshed: string[];
  let counter = 0;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'storage-cleanup-')));
    managedRoot = path.join(root, 'worktrees');
    dataDir = path.join(root, 'data');
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    await fs.mkdir(repo);
    git(repo, 'init', '--initial-branch=main');
    await fs.writeFile(path.join(repo, 'README.md'), '# repo\n');
    await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    settings = DEFAULT_STORAGE_CLEANUP_SETTINGS;
    sessions = async () => 0;
    refreshed = [];
    fixture.sqlite
      .prepare(
        `INSERT INTO workspaces (id, type, kind, location, path) VALUES ('repo-ws', 'local', 'repository', 'local', ?)`
      )
      .run(repo);
    fixture.sqlite
      .prepare(
        `INSERT INTO projects (id, name, repository_workspace_id) VALUES ('project-1', 'Project', 'repo-ws')`
      )
      .run();
  });

  afterEach(async () => {
    fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  function service(
    overrides: Partial<ConstructorParameters<typeof StorageCleanupService>[0]> = {}
  ) {
    return new StorageCleanupService({
      db: fixture.db,
      getSettings: async () => settings,
      paths: {
        logsDir: path.join(dataDir, 'logs'),
        activeLogNames: ['orkestra.log'],
        cacheDirs: [path.join(dataDir, 'media-cache'), path.join(dataDir, 'traces')],
        checkoutCacheDir: path.join(dataDir, 'worktree-checkout-cache'),
        attachmentsDir: path.join(dataDir, 'acp-attachments'),
      },
      managedWorktreeRoots: async () => [managedRoot],
      countSessions: (worktreePath) => sessions(worktreePath),
      refreshWorkspace: async (workspaceId) => {
        refreshed.push(workspaceId);
      },
      git: createCleanupGit(GIT_ENV),
      now: () => NOW,
      ...overrides,
    });
  }

  type TaskSeed = {
    status?: string;
    archivedAt?: number | null;
    statusChangedAt?: number;
    createdAt?: number;
    lastActivatedAt?: number | null;
    pinned?: boolean;
    extraTask?: boolean;
    agentStatus?: string | null;
    path?: string;
    createWorktree?: boolean;
    projectId?: string;
  };

  /** Bir görev worktree'si oluşturur ve veritabanına (Orkestra'nın oluşturduğu olarak) kaydeder. */
  async function seedWorktree(
    seed: TaskSeed = {}
  ): Promise<{ id: string; path: string; branch: string }> {
    counter++;
    const id = `ws-${counter}`;
    const branch = `orkestra/task-${counter}`;
    const worktreePath = seed.path ?? path.join(managedRoot, 'repo-pool', `task-${counter}`);
    if (seed.createWorktree !== false) {
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      git(repo, 'worktree', 'add', '-q', '--no-track', '-b', branch, worktreePath, 'origin/main');
    }
    const config: WorkspaceConfig = {
      version: '2',
      git: {
        kind: 'create-branch',
        branchName: branch,
        fromBranch: { type: 'local', branch: 'main' },
      },
      workspace: { kind: 'new-worktree' },
    };
    const old = NOW - 30 * DAY_MS;
    await fixture.db.insert(workspaces).values({
      id,
      type: 'local',
      kind: 'worktree',
      location: 'local',
      path: worktreePath,
      parentId: 'repo-ws',
      config,
      observedStatus: 'present',
      lastActivatedAt: seed.lastActivatedAt === undefined ? old : seed.lastActivatedAt,
    });
    const taskIds = seed.extraTask ? [`task-${counter}`, `task-${counter}-b`] : [`task-${counter}`];
    for (const taskId of taskIds) {
      await fixture.db.insert(tasks).values({
        id: taskId,
        projectId: seed.projectId ?? 'project-1',
        name: `Task ${counter}`,
        status: seed.status ?? 'in_progress',
        archivedAt: seed.archivedAt ? sqlTime(seed.archivedAt) : null,
        statusChangedAt: sqlTime(seed.statusChangedAt ?? old),
        createdAt: sqlTime(seed.createdAt ?? old),
        updatedAt: sqlTime(old),
        isPinned: seed.pinned ? 1 : 0,
        workspaceId: id,
      });
      await fixture.db.insert(conversations).values({
        id: `conv-${taskId}`,
        projectId: seed.projectId ?? 'project-1',
        taskId,
        title: 'Conversation',
        createdAt: sqlTime(old),
        updatedAt: sqlTime(old),
        agentStatus: seed.agentStatus ?? 'idle',
      });
    }
    return { id, path: worktreePath, branch };
  }

  const exists = (target: string) =>
    fs.lstat(target).then(
      () => true,
      () => false
    );

  async function runAndFind(workspaceId: string) {
    const report = await service().run('manual');
    return report.entries.find(
      (entry) => entry.kind === 'worktree' && entry.workspaceId === workspaceId
    );
  }

  it('does nothing while every policy is off (the default)', async () => {
    const wt = await seedWorktree();
    const report = await service().run('hourly');
    expect(report.entries).toEqual([]);
    expect(await exists(wt.path)).toBe(true);
  });

  it('removes an inactive worktree, keeps its branch and the conversation history', async () => {
    settings = rules({ inactiveDays: 7 });
    const wt = await seedWorktree();
    const entry = await runAndFind(wt.id);
    expect(entry).toMatchObject({ outcome: 'removed', reason: 'Inactive for 30 days' });
    expect(await exists(wt.path)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
    expect(git(repo, 'rev-parse', '--verify', `refs/heads/${wt.branch}`)).toMatch(
      /^[0-9a-f]{40}$/u
    );
    const [conversation] = await fixture.db
      .select()
      .from(conversations)
      .where(eq(conversations.taskId, `task-${counter}`));
    expect(conversation?.title).toBe('Conversation');
    expect(refreshed).toEqual([wt.id]);
    expect(await service().getCleanedWorktree(wt.id)).toMatchObject({
      workspaceId: wt.id,
      reason: 'Inactive for 30 days',
    });
    expect((await service().getLastReport())?.worktrees).toBe(1);
    // Boş kalan havuz klasörü de kaldırılır; yönetilen kökün kendisi kalır.
    expect(await exists(path.dirname(wt.path))).toBe(false);
    expect(await exists(managedRoot)).toBe(true);
  });

  it('keeps a worktree that is not inactive long enough', async () => {
    settings = rules({ inactiveDays: 60 });
    const wt = await seedWorktree();
    expect(await runAndFind(wt.id)).toMatchObject({
      outcome: 'kept',
      reason: 'Inactive for 30 of 60 days',
    });
    expect(await exists(wt.path)).toBe(true);
  });

  it('removes a worktree after its task was archived for N days (0 = next run)', async () => {
    settings = rules({ settledDays: 0 });
    const archived = await seedWorktree({ archivedAt: NOW - 2 * 60 * 60 * 1000 });
    const active = await seedWorktree();
    const report = await service().run('manual');
    const byId = new Map(
      report.entries.flatMap((entry) =>
        entry.kind === 'worktree' ? [[entry.workspaceId, entry]] : []
      )
    );
    expect(byId.get(archived.id)).toMatchObject({
      outcome: 'removed',
      reason: 'Archived for 0 days',
    });
    expect(byId.get(active.id)).toMatchObject({
      outcome: 'kept',
      reason: 'Task is not settled or archived',
    });
  });

  it('counts done tasks as settled and waits for the retention period', async () => {
    settings = rules({ settledDays: 5 });
    const done = await seedWorktree({ status: 'done', statusChangedAt: NOW - 2 * DAY_MS });
    expect(await runAndFind(done.id)).toMatchObject({
      outcome: 'kept',
      reason: 'Settled for 2 of 5 days',
    });
    settings = rules({ settledDays: 1 });
    expect(await runAndFind(done.id)).toMatchObject({
      outcome: 'removed',
      reason: 'Settled for 2 days',
    });
  });

  it('removes a worktree whose branch was merged into the default branch', async () => {
    settings = rules({ onMerge: true });
    const merged = await seedWorktree();
    await fs.writeFile(path.join(merged.path, 'feature.txt'), 'feature\n');
    git(merged.path, 'add', '-A');
    git(merged.path, 'commit', '-m', 'feature');
    git(merged.path, 'push', '-q', 'origin', `HEAD:refs/heads/main`);
    git(repo, 'fetch', '-q', 'origin');
    const unmerged = await seedWorktree();
    await fs.writeFile(path.join(unmerged.path, 'wip.txt'), 'wip\n');
    git(unmerged.path, 'add', '-A');
    git(unmerged.path, 'commit', '-m', 'wip');
    git(unmerged.path, 'push', '-q', 'origin', `HEAD:refs/heads/${unmerged.branch}`);
    git(repo, 'fetch', '-q', 'origin');
    // Hiç commit'i olmayan yeni bir worktree birleşmiş sayılmaz.
    const fresh = await seedWorktree();

    const report = await service().run('manual');
    const outcome = (id: string) =>
      report.entries.find((entry) => entry.kind === 'worktree' && entry.workspaceId === id);
    expect(outcome(merged.id)).toMatchObject({
      outcome: 'removed',
      reason: 'Branch was merged into the default branch',
    });
    expect(outcome(unmerged.id)).toMatchObject({ outcome: 'kept', reason: 'Not merged' });
    expect(outcome(fresh.id)).toMatchObject({ outcome: 'kept', reason: 'Not merged' });
  });

  it('removes an unchanged worktree only once its task is settled or archived', async () => {
    settings = rules({ unchanged: true });
    const settled = await seedWorktree({ status: 'cancelled', statusChangedAt: NOW - DAY_MS });
    const active = await seedWorktree();
    const changed = await seedWorktree({ archivedAt: NOW - DAY_MS });
    await fs.writeFile(path.join(changed.path, 'x.txt'), 'x\n');
    git(changed.path, 'add', '-A');
    git(changed.path, 'commit', '-m', 'x');
    git(changed.path, 'push', '-q', 'origin', `HEAD:refs/heads/${changed.branch}`);
    const report = await service().run('manual');
    const outcome = (id: string) =>
      report.entries.find((entry) => entry.kind === 'worktree' && entry.workspaceId === id);
    expect(outcome(settled.id)).toMatchObject({
      outcome: 'removed',
      reason: 'No commits beyond the default branch',
    });
    expect(outcome(active.id)).toMatchObject({
      outcome: 'kept',
      reason: 'Task is not settled or archived',
    });
    expect(outcome(changed.id)).toMatchObject({
      outcome: 'kept',
      reason: 'Has commits beyond the default branch',
    });
  });

  it('compares against the project branch in repositories without remotes', async () => {
    git(repo, 'remote', 'remove', 'origin');
    settings = rules({ unchanged: true });
    const wt = await seedWorktree({ createWorktree: false, archivedAt: NOW - DAY_MS });
    git(repo, 'worktree', 'add', '-q', '-b', wt.branch, wt.path, 'main');
    expect(await runAndFind(wt.id)).toMatchObject({
      outcome: 'removed',
      reason: 'No commits beyond the project branch',
    });
  });

  describe('safety rules', () => {
    beforeEach(() => {
      settings = rules({ inactiveDays: 1 });
    });

    it('never removes a worktree with uncommitted tracked changes', async () => {
      const wt = await seedWorktree();
      await fs.appendFile(path.join(wt.path, 'README.md'), 'edit\n');
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Has uncommitted changes (1 file)',
      });
      expect(await exists(wt.path)).toBe(true);
    });

    it('never removes a worktree with untracked files', async () => {
      const wt = await seedWorktree();
      await fs.writeFile(path.join(wt.path, 'notes.txt'), 'draft\n');
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Has uncommitted changes (1 file)',
      });
    });

    it('does not let ignored files (.env, node_modules) block removal', async () => {
      const wt = await seedWorktree();
      await fs.writeFile(path.join(wt.path, '.env'), 'X=1\n');
      await fs.mkdir(path.join(wt.path, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(wt.path, 'node_modules', 'pkg', 'index.js'), '');
      expect(await runAndFind(wt.id)).toMatchObject({ outcome: 'removed' });
      expect(await exists(wt.path)).toBe(false);
    });

    it('never removes a worktree with unpushed commits when a remote exists', async () => {
      const wt = await seedWorktree();
      await fs.writeFile(path.join(wt.path, 'local.txt'), 'local\n');
      git(wt.path, 'add', '-A');
      git(wt.path, 'commit', '-m', 'local only');
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Has 1 commit not pushed to a remote',
      });
    });

    it('removes committed work in repositories without a remote (the branch keeps it)', async () => {
      git(repo, 'remote', 'remove', 'origin');
      const wt = await seedWorktree({ createWorktree: false });
      git(repo, 'worktree', 'add', '-q', '-b', wt.branch, wt.path, 'main');
      await fs.writeFile(path.join(wt.path, 'local.txt'), 'local\n');
      git(wt.path, 'add', '-A');
      git(wt.path, 'commit', '-m', 'local only');
      expect(await runAndFind(wt.id)).toMatchObject({ outcome: 'removed' });
      expect(git(repo, 'log', '-1', '--format=%s', wt.branch)).toBe('local only');
    });

    it('never removes a worktree with an open agent or terminal session', async () => {
      const wt = await seedWorktree();
      sessions = async (worktreePath) => (worktreePath === wt.path ? 1 : 0);
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'An agent or terminal session is open',
      });
      sessions = async () => {
        throw new Error('runtime down');
      };
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Running sessions could not be checked',
      });
    });

    it('re-checks right before removal: a session opened meanwhile cancels it', async () => {
      const wt = await seedWorktree();
      let calls = 0;
      sessions = async () => (++calls === 1 ? 0 : 1);
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'An agent or terminal session is open',
      });
      expect(calls).toBe(2);
      expect(await exists(wt.path)).toBe(true);
    });

    it('never removes a worktree whose agent is working', async () => {
      const wt = await seedWorktree({ agentStatus: 'working' });
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'An agent is working in this task',
      });
    });

    it('never removes a worktree opened recently', async () => {
      const wt = await seedWorktree({ lastActivatedAt: NOW - 10 * 60 * 1000 });
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Opened or active in the last hour',
      });
    });

    it('keeps pinned tasks and worktrees shared by several tasks', async () => {
      const pinned = await seedWorktree({ pinned: true });
      const shared = await seedWorktree({ extraTask: true });
      const report = await service().run('manual');
      const outcome = (id: string) =>
        report.entries.find((entry) => entry.kind === 'worktree' && entry.workspaceId === id);
      expect(outcome(pinned.id)).toMatchObject({ outcome: 'kept', reason: 'Task is pinned' });
      expect(outcome(shared.id)).toMatchObject({ outcome: 'kept', reason: 'Shared by 2 tasks' });
    });

    it('never touches worktrees outside the Orkestra worktree folders', async () => {
      const outside = path.join(root, 'elsewhere', 'task');
      const wt = await seedWorktree({ path: outside });
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Outside the Orkestra worktree folders',
      });
      expect(await exists(outside)).toBe(true);
    });

    it('refuses symlink escapes', async () => {
      // Yönetilen kök içinde dışarıyı gösteren bir symlink: worktree yolu doğrudan symlink.
      const outsideWorktree = path.join(root, 'outside', 'real-task');
      const direct = await seedWorktree({ path: outsideWorktree });
      const link = path.join(managedRoot, 'linked-task');
      await fs.symlink(outsideWorktree, link);
      await fixture.db.update(workspaces).set({ path: link }).where(eq(workspaces.id, direct.id));
      // Symlink'li bir üst klasör üzerinden kaçış: gerçek yol kökün dışında.
      const outsidePool = path.join(root, 'outside-pool');
      await fs.mkdir(outsidePool, { recursive: true });
      await fs.symlink(outsidePool, path.join(managedRoot, 'pool-link'));
      const viaParent = await seedWorktree({ path: path.join(managedRoot, 'pool-link', 'task') });

      const report = await service().run('manual');
      const outcome = (id: string) =>
        report.entries.find((entry) => entry.kind === 'worktree' && entry.workspaceId === id);
      expect(outcome(direct.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Worktree is a symbolic link',
      });
      expect(outcome(viaParent.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Outside the Orkestra worktree folders',
      });
      expect(await exists(outsideWorktree)).toBe(true);
      expect(await exists(path.join(outsidePool, 'task'))).toBe(true);
    });

    it('never removes the main checkout of a project', async () => {
      // Ana checkout yönetilen kökün içinde olsa ve bir görev worktree'si gibi kayıtlı olsa bile.
      const insideRepo = path.join(managedRoot, 'main-checkout');
      await fs.mkdir(insideRepo);
      git(insideRepo, 'init', '--initial-branch=main');
      await fs.writeFile(path.join(insideRepo, 'a.txt'), 'a\n');
      git(insideRepo, 'add', '-A');
      git(insideRepo, 'commit', '-m', 'a');
      const wt = await seedWorktree({ path: insideRepo, createWorktree: false });
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Not a linked worktree',
      });
      // Aynı klasör farklı yazımla projenin depo kökü olarak kayıtlı (yol tekilliği nedeniyle).
      fixture.sqlite
        .prepare(`UPDATE workspaces SET path = ? WHERE id = 'repo-ws'`)
        .run(`${insideRepo}/`);
      expect(await runAndFind(wt.id)).toMatchObject({
        outcome: 'kept',
        reason: 'Main checkout of the project',
      });
      expect(await exists(path.join(insideRepo, 'a.txt'))).toBe(true);
    });

    it('lets git refuse locked worktrees and reports the failure', async () => {
      const wt = await seedWorktree();
      git(repo, 'worktree', 'lock', '--reason', 'busy', wt.path);
      const entry = await runAndFind(wt.id);
      expect(entry).toMatchObject({ outcome: 'failed' });
      expect(entry?.reason).toContain('git worktree remove');
      expect(await exists(wt.path)).toBe(true);
    });
  });

  it('applies per-project overrides: Off and Custom', async () => {
    fixture.sqlite.prepare(`INSERT INTO projects (id, name) VALUES ('project-2', 'Other')`).run();
    const inherit = await seedWorktree();
    const off = await seedWorktree({ projectId: 'project-2' });
    settings = {
      ...rules({ inactiveDays: 7 }),
      projectOverrides: { 'project-2': { mode: 'off' } },
    };
    let report = await service().run('manual');
    expect(report.entries.map((entry) => entry.kind === 'worktree' && entry.workspaceId)).toEqual([
      inherit.id,
    ]);
    expect(await exists(off.path)).toBe(true);

    settings = {
      ...DEFAULT_STORAGE_CLEANUP_SETTINGS,
      projectOverrides: {
        'project-2': { mode: 'custom', rules: { ...DISABLED_WORKTREE_RULES, inactiveDays: 3 } },
      },
    };
    report = await service().run('manual');
    expect(report.entries).toEqual([
      expect.objectContaining({ workspaceId: off.id, outcome: 'removed' }),
    ]);
  });

  it('dry run reports exactly what a real run removes, and removes nothing', async () => {
    settings = rules({ inactiveDays: 7, settledDays: 0 });
    const a = await seedWorktree();
    const b = await seedWorktree({
      archivedAt: NOW - 3 * 60 * 60 * 1000,
      lastActivatedAt: null,
      createdAt: NOW - 3 * 60 * 60 * 1000,
    });
    const dirty = await seedWorktree();
    await fs.writeFile(path.join(dirty.path, 'new.txt'), 'x\n');
    const recent = await seedWorktree({ lastActivatedAt: NOW - 60_000 });

    const preview = await service().preview();
    expect(preview.dryRun).toBe(true);
    for (const wt of [a, b, dirty, recent]) expect(await exists(wt.path)).toBe(true);
    expect(await service().getLastReport()).toBeNull();
    const wouldRemove = preview.entries
      .filter((entry) => entry.kind === 'worktree' && entry.outcome === 'would-remove')
      .map((entry) => (entry.kind === 'worktree' ? entry.workspaceId : ''))
      .sort();
    expect(wouldRemove).toEqual([a.id, b.id].sort());
    expect(preview.worktrees).toBe(2);
    expect(preview.bytes).toBeGreaterThan(0);

    const real = await service().run('manual');
    const removed = real.entries
      .filter((entry) => entry.kind === 'worktree' && entry.outcome === 'removed')
      .map((entry) => (entry.kind === 'worktree' ? entry.workspaceId : ''))
      .sort();
    expect(removed).toEqual(wouldRemove);
    expect(await exists(dirty.path)).toBe(true);
    expect(await exists(recent.path)).toBe(true);
  });

  it('expires rotated logs and caches but keeps current logs and never follows symlinks', async () => {
    settings = { ...DEFAULT_STORAGE_CLEANUP_SETTINGS, logsDays: 7, cachesDays: 14 };
    const logs = path.join(dataDir, 'logs');
    const media = path.join(dataDir, 'media-cache');
    const traces = path.join(dataDir, 'traces');
    const checkoutCache = path.join(dataDir, 'worktree-checkout-cache');
    const outside = path.join(root, 'precious');
    for (const dir of [
      logs,
      media,
      traces,
      path.join(checkoutCache, 'old-bucket'),
      path.join(checkoutCache, 'new-bucket'),
      outside,
    ]) {
      await fs.mkdir(dir, { recursive: true });
    }
    const write = async (file: string, ageDays: number) => {
      await fs.writeFile(file, 'x'.repeat(100));
      const at = (NOW - ageDays * DAY_MS) / 1000;
      await fs.utimes(file, at, at);
    };
    await write(path.join(logs, 'orkestra.log'), 30);
    await write(path.join(logs, 'orkestra.log.1'), 30);
    await write(path.join(logs, 'orkestra.log.2'), 2);
    await write(path.join(logs, 'emdash.log'), 30);
    await write(path.join(logs, 'notes.txt'), 30);
    await write(path.join(media, 'old.png'), 20);
    await write(path.join(media, 'new.png'), 1);
    await write(path.join(traces, 'trace.json'), 20);
    await write(path.join(outside, 'keep.txt'), 100);
    await fs.symlink(path.join(outside, 'keep.txt'), path.join(media, 'link.png'));
    await fs.symlink(outside, path.join(traces, 'linked-dir'));
    const oldBucket = (NOW - 20 * DAY_MS) / 1000;
    await fs.utimes(path.join(checkoutCache, 'old-bucket'), oldBucket, oldBucket);
    const recentBucket = (NOW - DAY_MS) / 1000;
    await fs.utimes(path.join(checkoutCache, 'new-bucket'), recentBucket, recentBucket);

    const preview = await service().preview();
    expect(await exists(path.join(logs, 'orkestra.log.1'))).toBe(true);
    const report = await service().run('manual');
    const files = (category: string) =>
      report.entries.find((entry) => entry.kind === 'files' && entry.category === category);
    expect(files('logs')).toMatchObject({ outcome: 'removed', files: 2 });
    expect(files('caches')).toMatchObject({ outcome: 'removed', files: 2 });
    expect(files('checkoutCache')).toMatchObject({ outcome: 'removed', files: 1 });
    // Kuru çalıştırma aynı sayıları verdi.
    expect(
      preview.entries.map((entry) =>
        entry.kind === 'files' ? [entry.category, entry.files] : null
      )
    ).toEqual(
      report.entries.map((entry) => (entry.kind === 'files' ? [entry.category, entry.files] : null))
    );

    expect(await exists(path.join(logs, 'orkestra.log'))).toBe(true);
    expect(await exists(path.join(logs, 'orkestra.log.1'))).toBe(false);
    expect(await exists(path.join(logs, 'orkestra.log.2'))).toBe(true);
    expect(await exists(path.join(logs, 'emdash.log'))).toBe(false);
    expect(await exists(path.join(logs, 'notes.txt'))).toBe(true);
    expect(await exists(path.join(media, 'old.png'))).toBe(false);
    expect(await exists(path.join(media, 'new.png'))).toBe(true);
    expect(await exists(path.join(traces, 'trace.json'))).toBe(false);
    expect(await exists(path.join(outside, 'keep.txt'))).toBe(true);
    expect(await exists(path.join(checkoutCache, 'old-bucket'))).toBe(false);
    expect(await exists(path.join(checkoutCache, 'new-bucket'))).toBe(true);
  });

  it('measures disk usage per category', async () => {
    await seedWorktree();
    await fs.mkdir(path.join(dataDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'logs', 'orkestra.log'), 'x'.repeat(5000));
    const usage = await service().getUsage();
    const bytes = (category: string) =>
      usage.categories.find((entry) => entry.category === category)?.bytes;
    expect(bytes('worktrees')).toBeGreaterThan(0);
    expect(bytes('logs')).toBeGreaterThan(0);
    expect(bytes('checkoutCache')).toBe(0);
    expect(usage.categories.find((entry) => entry.category === 'attachments')?.neverRemoved).toBe(
      true
    );
  });

  it('lists projects for the override picker', async () => {
    expect(await service().listProjects()).toEqual([{ id: 'project-1', name: 'Project' }]);
    void projects;
  });
});
