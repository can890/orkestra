import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGED_POLICY_PATH_ENV } from '@orkestra/shared/managed-policy/node';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentMetadataList } from '@core/features/agents/node/agent-payload-builder';
import { appSettingsContributions } from '@core/manifests/node/settings-contributions';
import { ManagedSettingLockedError } from '@core/primitives/managed-policy/api/managed-settings';
import {
  getActiveManagedPolicy,
  managedCapabilityDenial,
  managedProviderDenial,
  managedUpdatesDenial,
  setActiveManagedPolicy,
} from '@core/primitives/managed-policy/api/node/active-policy';
import { resolveTmux } from '@core/primitives/project-settings/api/effective-settings';
import type { AppDb } from '@core/services/app-db/node/db';
import { appSettings } from '@core/services/app-db/node/schema';
import { createAppSettingsService } from '@core/services/settings/node';
import {
  applyManagedPolicyLoadResult,
  loadManagedPolicyAtStartup,
  MANAGED_POLICY_EXIT_CODE,
} from './load-managed-policy';

// Uçtan uca: politika dosyası geçici dizinden açılış yoluyla yüklenir, ayar servisi gerçek
// SQLite üzerinde bu politikayla kurulur; yazımlar reddedilir, etkin değerler politikanınkidir.

const POLICY = {
  schemaVersion: 1,
  organization: 'Example Corp',
  settings: {
    'tasks.defaultPermissionMode': { value: 'default', locked: true },
    'project.tmuxByDefault': { value: true, locked: true },
    'updates.autoDownload': { value: false, locked: false },
  },
  limits: {
    maxPermissionMode: 'acceptEdits',
    providers: { denied: ['codex'] },
    remoteAccess: false,
    outsideAgents: false,
    updates: { mode: 'off' },
  },
};

function createTestDb(): { sqlite: Database.Database; db: AppDb } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
  `);
  return { sqlite, db: drizzle(sqlite) as unknown as AppDb };
}

let dir: string;
let sqlite: Database.Database;
let db: AppDb;

async function bootWithPolicy(policy: unknown) {
  const file = join(dir, 'policy.json');
  await writeFile(file, typeof policy === 'string' ? policy : JSON.stringify(policy));
  return loadManagedPolicyAtStartup({
    allowPathOverride: true,
    env: { [MANAGED_POLICY_PATH_ENV]: file },
    platform: 'linux',
  });
}

function rawRow(key: string): unknown {
  const [row] = db.select().from(appSettings).where(eq(appSettings.key, key)).all();
  return row ? JSON.parse(row.value) : undefined;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orkestra-managed-policy-'));
  ({ sqlite, db } = createTestDb());
});

afterEach(async () => {
  setActiveManagedPolicy(undefined);
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

describe('managed policy at startup', () => {
  it('starts unmanaged when no policy is installed', async () => {
    const decision = await loadManagedPolicyAtStartup({
      allowPathOverride: false,
      platform: 'linux',
      fs: { readText: async () => undefined, exists: async () => false },
    });
    expect(decision).toEqual({ kind: 'start', managed: false });
    expect(getActiveManagedPolicy()).toBeUndefined();
    expect(managedProviderDenial('codex')).toBeUndefined();
    expect(managedCapabilityDenial('remoteAccess')).toBeUndefined();
    expect(managedUpdatesDenial()).toBeUndefined();
  });

  it('refuses to start (fail-closed) with an invalid policy', async () => {
    const decision = await bootWithPolicy({ ...POLICY, limits: { telemetry: false } });
    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') return;
    expect(decision.exitCode).toBe(MANAGED_POLICY_EXIT_CODE);
    expect(decision.message).toMatch(/cannot use the managed policy at .*policy\.json/);
    expect(getActiveManagedPolicy()).toBeUndefined();
  });

  it('refuses an unknown agent id against the real plugin registry', async () => {
    const decision = await bootWithPolicy({
      ...POLICY,
      limits: { providers: { allowed: ['definitely-not-an-agent'] } },
    });
    expect(decision.kind).toBe('refuse');
  });

  it('maps every load result to a decision', () => {
    expect(applyManagedPolicyLoadResult({ kind: 'none', searched: [] })).toEqual({
      kind: 'start',
      managed: false,
    });
    expect(
      applyManagedPolicyLoadResult({
        kind: 'error',
        error: { source: '/etc/orkestra/policy.json', reason: 'bad' },
        message: 'bad policy',
      })
    ).toEqual({ kind: 'refuse', message: 'bad policy', exitCode: 78 });
  });
});

describe('settings service with a managed policy', () => {
  it('enforces locks on every write path and reports policy values', async () => {
    expect(await bootWithPolicy(POLICY)).toEqual({ kind: 'start', managed: true });
    const managed = getActiveManagedPolicy()?.settings;
    expect(managed).toBeDefined();

    // Politikadan önce kullanıcının kendi seçimi.
    db.insert(appSettings)
      .values({ key: 'tasks', value: JSON.stringify({ defaultPermissionMode: 'bypass' }) })
      .run();

    const service = createAppSettingsService({
      db,
      contributions: appSettingsContributions,
      managed: managed!,
    });

    const tasks = await service.get('tasks');
    expect(tasks.defaultPermissionMode).toBe('default');
    expect(tasks.autoApproveByDefault).toBe(false);
    expect((await service.get('project')).tmuxByDefault).toBe(true);
    expect((await service.get('updates')).autoDownload).toBe(false);

    await expect(
      service.update('tasks', { ...tasks, defaultPermissionMode: 'auto' })
    ).rejects.toBeInstanceOf(ManagedSettingLockedError);
    await expect(
      service.update('project', { ...(await service.get('project')), tmuxByDefault: false })
    ).rejects.toThrow(/Example Corp manages the "project.tmuxByDefault" setting/);
    await expect(service.resetField('tasks', 'defaultPermissionMode')).rejects.toBeInstanceOf(
      ManagedSettingLockedError
    );

    // İzinli bir yazım kilitli alana dokunmaz: kullanıcının kayıtlı seçimi korunur.
    await service.update('tasks', { ...tasks, autoGenerateName: false });
    expect(rawRow('tasks')).toEqual({ defaultPermissionMode: 'bypass', autoGenerateName: false });
    expect((await service.get('tasks')).defaultPermissionMode).toBe('default');

    // Kilitsiz varsayılan kullanıcı tarafından değiştirilebilir.
    await service.update('updates', { autoDownload: true });
    expect((await service.get('updates')).autoDownload).toBe(true);
    expect(rawRow('updates')).toEqual({ autoDownload: true });

    const meta = await service.getWithMeta('tasks');
    expect(meta.defaults.defaultPermissionMode).toBe('default');
  });

  it('keeps today’s behaviour without a policy', async () => {
    const service = createAppSettingsService({ db, contributions: appSettingsContributions });
    const tasks = await service.get('tasks');
    await service.update('tasks', { ...tasks, defaultPermissionMode: 'bypass' });
    expect((await service.get('tasks')).defaultPermissionMode).toBe('bypass');
    expect(rawRow('tasks')).toEqual({ defaultPermissionMode: 'bypass' });
  });
});

describe('policy limits', () => {
  it('denies providers, capabilities and updates; hides denied agents from pickers', async () => {
    await bootWithPolicy(POLICY);
    expect(managedProviderDenial('codex')).toBe(
      'Example Corp\'s policy does not allow the "codex" agent.'
    );
    expect(managedProviderDenial('claude')).toBeUndefined();
    expect(managedCapabilityDenial('remoteAccess')).toMatch(/remote access/);
    // Uzak erişim kapalıyken eşleştirme de kapalıdır.
    expect(managedCapabilityDenial('devicePairing')).toMatch(/pairing/);
    expect(managedCapabilityDenial('outsideAgents')).toMatch(/outside-agent/);
    expect(managedUpdatesDenial()).toBe('Example Corp manages Orkestra updates.');
    const ids = buildAgentMetadataList().map((agent) => agent.id);
    expect(ids).toContain('claude');
    expect(ids).not.toContain('codex');
  });

  it('locks the project tmux override layer', () => {
    expect(
      resolveTmux({ projectTmux: false, hostTmux: false, appDefaultTmux: false, managedTmux: true })
        .value
    ).toBe(true);
    expect(resolveTmux({ projectTmux: false, hostTmux: true, appDefaultTmux: true }).value).toBe(
      false
    );
  });
});
