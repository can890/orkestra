import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeLoadedManagedPolicy,
  LINUX_MANAGED_POLICY_FILE,
  loadManagedPolicyFile,
  MACOS_MANAGED_POLICY_FILE,
  MACOS_MANAGED_PREFERENCES_FILE,
  MANAGED_POLICY_PATH_ENV,
  readManagedPolicy,
  type ManagedPolicyFs,
} from './index';

const POLICY = {
  schemaVersion: 1,
  organization: 'Example Corp',
  supportUrl: 'https://it.example.com/orkestra',
  settings: {
    'tasks.defaultPermissionMode': { value: 'default', locked: true },
    'updates.autoDownload': { value: false, locked: false },
  },
  limits: {
    maxPermissionMode: 'acceptEdits',
    providers: { denied: ['codex'] },
    remoteAccess: false,
    devicePairing: false,
    outsideAgents: false,
    updates: { mode: 'off' },
  },
};

function memoryFs(files: Record<string, string>): ManagedPolicyFs {
  return {
    readText: async (path) => files[path],
    exists: async (path) => path in files,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orkestra-policy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readManagedPolicy', () => {
  it('reports no policy when nothing is installed', async () => {
    const result = await readManagedPolicy({ platform: 'linux', fs: memoryFs({}) });
    expect(result).toEqual({ kind: 'none', searched: [LINUX_MANAGED_POLICY_FILE] });
  });

  it('loads the Linux system file', async () => {
    const result = await readManagedPolicy({
      platform: 'linux',
      fs: memoryFs({ [LINUX_MANAGED_POLICY_FILE]: JSON.stringify(POLICY) }),
    });
    expect(result.kind).toBe('loaded');
    if (result.kind !== 'loaded') return;
    expect(result.loaded.summary).toMatchObject({
      organization: 'Example Corp',
      source: LINUX_MANAGED_POLICY_FILE,
      lockedSettings: ['tasks.defaultPermissionMode'],
      defaultedSettings: ['updates.autoDownload'],
    });
    expect(result.loaded.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('fingerprints the policy independent of key order', async () => {
    const { schemaVersion, organization, supportUrl, settings, limits } = POLICY;
    const reordered = { limits, settings, supportUrl, organization, schemaVersion };
    const a = await readManagedPolicy({
      platform: 'linux',
      fs: memoryFs({ [LINUX_MANAGED_POLICY_FILE]: JSON.stringify(POLICY) }),
    });
    const b = await readManagedPolicy({
      platform: 'linux',
      fs: memoryFs({ [LINUX_MANAGED_POLICY_FILE]: JSON.stringify(reordered, null, 2) }),
    });
    expect(a.kind === 'loaded' && b.kind === 'loaded').toBe(true);
    if (a.kind === 'loaded' && b.kind === 'loaded') {
      expect(a.loaded.fingerprint).toBe(b.loaded.fingerprint);
    }
  });

  it('fails closed on an invalid file and names the source', async () => {
    const result = await readManagedPolicy({
      platform: 'linux',
      fs: memoryFs({ [LINUX_MANAGED_POLICY_FILE]: '{"schemaVersion":1}' }),
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain(LINUX_MANAGED_POLICY_FILE);
    expect(result.message).toContain('It will not start until an administrator fixes this.');
  });

  it('fails closed when the file cannot be read', async () => {
    const result = await readManagedPolicy({
      platform: 'linux',
      fs: {
        readText: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
        exists: async () => true,
      },
    });
    expect(result.kind).toBe('error');
  });

  it('reads a macOS configuration profile, including MCX-wrapped payloads', async () => {
    const result = await readManagedPolicy({
      platform: 'darwin',
      fs: memoryFs({ [MACOS_MANAGED_PREFERENCES_FILE]: 'plist' }),
      convertPlistToJson: async () =>
        JSON.stringify({
          PayloadUUID: 'x',
          Forced: [{ mcx_preference_settings: { ...POLICY, _manualProfile: true } }],
        }),
    });
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') expect(result.loaded.source).toBe(MACOS_MANAGED_PREFERENCES_FILE);
  });

  it('refuses a machine with both a profile and a policy file', async () => {
    const result = await readManagedPolicy({
      platform: 'darwin',
      fs: memoryFs({
        [MACOS_MANAGED_PREFERENCES_FILE]: 'plist',
        [MACOS_MANAGED_POLICY_FILE]: JSON.stringify(POLICY),
      }),
      convertPlistToJson: async () => JSON.stringify(POLICY),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/remove one of them/);
  });

  it('honours the path override only when allowed', async () => {
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify(POLICY));
    const env = { [MANAGED_POLICY_PATH_ENV]: path };
    const ignored = await readManagedPolicy({ platform: 'linux', env, fs: memoryFs({}) });
    expect(ignored.kind).toBe('none');
    const used = await readManagedPolicy({ platform: 'linux', env, allowPathOverride: true });
    expect(used.kind).toBe('loaded');
  });

  it('rejects unknown agent ids when the caller knows the registry', async () => {
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify(POLICY));
    const result = await loadManagedPolicyFile(path, { knownProviderIds: ['claude'] });
    expect(result.kind).toBe('error');
  });
});

describe('describeLoadedManagedPolicy', () => {
  it('prints what the policy will do', async () => {
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify(POLICY));
    const result = await loadManagedPolicyFile(path);
    if (result.kind !== 'loaded') throw new Error('expected a policy');
    const text = describeLoadedManagedPolicy(result.loaded)
      .replace(path, '<policy.json>')
      .replace(result.loaded.fingerprint, '<fingerprint>');
    expect(text).toMatchInlineSnapshot(`
      "Managed by Example Corp (<policy.json>, fingerprint <fingerprint>).
      Support: https://it.example.com/orkestra

      Settings:
        tasks.defaultPermissionMode = "default" (locked: users cannot change it) — Default permission mode for new conversations
        updates.autoDownload = false (default: users can change it) — Download updates automatically

      Limits:
        Broadest permission mode: Accept edits (acceptEdits). Broader modes are lowered to it when a conversation starts and refused when selected.
        Agents denied: codex. They cannot be started and are hidden from pickers.
        Remote access (mobile devices): off. Paired devices cannot connect.
        Device pairing: off. New devices cannot be paired.
        Outside-agent MCP server: off.
        Updates: off. Orkestra does not check for, download or install updates.
      "
    `);
  });
});
