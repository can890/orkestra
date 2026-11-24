import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LINUX_MANAGED_POLICY_FILE } from '@orkestra/shared/managed-policy/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPolicyCli, type PolicyCliDeps } from './policy-cli';

const POLICY = {
  schemaVersion: 1,
  organization: 'Example Corp',
  settings: {
    'tasks.defaultPermissionMode': { value: 'default', locked: true },
  },
  limits: {
    maxPermissionMode: 'acceptEdits',
    providers: { allowed: ['claude'] },
    outsideAgents: false,
  },
};

let dir: string;
let out: string;
let err: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orkestra-policy-cli-'));
  out = '';
  err = '';
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<PolicyCliDeps> = {}): PolicyCliDeps {
  return {
    homeDirectory: dir,
    platform: 'linux',
    env: {},
    allowPathOverride: false,
    knownProviderIds: ['claude', 'codex'],
    fs: { readText: async () => undefined, exists: async () => false },
    readLoadedState: async () => null,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    ...overrides,
  };
}

describe('policy check', () => {
  it('prints what a valid policy will do', async () => {
    const file = join(dir, 'policy.json');
    await writeFile(file, JSON.stringify(POLICY));
    expect(await runPolicyCli(['check', file], deps({ fs: undefined }))).toBe(0);
    expect(out.replace(file, '<file>').replace(/fingerprint [0-9a-f]{12}/, 'fingerprint <fp>'))
      .toMatchInlineSnapshot(`
        "Managed by Example Corp (<file>, fingerprint <fp>).

        Settings:
          tasks.defaultPermissionMode = "default" (locked: users cannot change it) — Default permission mode for new conversations

        Limits:
          Broadest permission mode: Accept edits (acceptEdits). Broader modes are lowered to it when a conversation starts and refused when selected.
          Agents allowed: claude. Other agents cannot be started and are hidden from pickers.
          Outside-agent MCP server: off.

        The policy is valid. Deploy it, then restart Orkestra on the machine.
        "
      `);
  });

  it('explains an invalid policy and exits non-zero', async () => {
    const file = join(dir, 'policy.json');
    await writeFile(file, JSON.stringify({ ...POLICY, limits: { providers: { allowed: ['x'] } } }));
    expect(await runPolicyCli(['check', file], deps({ fs: undefined }))).toBe(1);
    expect(err).toContain('"x" is not an agent this version of Orkestra knows');
    expect(err).toContain('It will not start until an administrator fixes this.');
  });

  it('refuses a missing draft', async () => {
    expect(await runPolicyCli(['check', join(dir, 'nope.json')], deps({ fs: undefined }))).toBe(1);
    expect(err).toMatch(/No policy file at/);
  });
});

describe('policy show', () => {
  it('reports no policy', async () => {
    expect(await runPolicyCli(['show'], deps())).toBe(0);
    expect(out).toContain('No managed policy on this machine');
    expect(out).toContain('No running Orkestra host reports a loaded policy.');
  });

  it('compares the installed policy with what the running host loaded', async () => {
    const fs = {
      readText: async (path: string) =>
        path === LINUX_MANAGED_POLICY_FILE ? JSON.stringify(POLICY) : undefined,
      exists: async () => false,
    };
    expect(await runPolicyCli(['show'], deps({ fs }))).toBe(0);
    const fingerprint = /fingerprint ([0-9a-f]{12})/.exec(out)![1]!;
    out = '';
    await runPolicyCli(
      ['show'],
      deps({
        fs,
        isProcessAlive: () => true,
        readLoadedState: async () => ({
          pid: 42,
          startedAt: '2026-11-24T10:00:00.000Z',
          policy: { source: LINUX_MANAGED_POLICY_FILE, organization: 'Example Corp', fingerprint },
        }),
      })
    );
    expect(out).toContain(
      'The running Orkestra host (pid 42, started 2026-11-24T10:00:00.000Z) loaded this policy.'
    );
    out = '';
    await runPolicyCli(
      ['show'],
      deps({
        fs,
        isProcessAlive: () => true,
        readLoadedState: async () => ({
          pid: 42,
          startedAt: 'x',
          policy: { source: '/old', organization: 'Old Corp', fingerprint: 'aaaaaaaaaaaa' },
        }),
      })
    );
    expect(out).toContain('Restart Orkestra to apply the installed policy.');
  });

  it('fails when the installed policy is invalid', async () => {
    const fs = {
      readText: async (path: string) => (path === LINUX_MANAGED_POLICY_FILE ? '{' : undefined),
      exists: async () => false,
    };
    expect(await runPolicyCli(['show'], deps({ fs }))).toBe(1);
    expect(err).toContain('not valid JSON');
  });
});

describe('policy settings', () => {
  it('lists manageable settings', async () => {
    expect(await runPolicyCli(['settings'], deps())).toBe(0);
    expect(out).toContain('tasks.defaultPermissionMode');
    expect(out).toContain('updates.autoDownload');
  });
});
