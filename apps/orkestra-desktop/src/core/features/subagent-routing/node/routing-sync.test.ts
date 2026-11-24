import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import { SUBAGENT_ROUTER_EXPRESSION, type SubagentRouter } from '@orkestra/core/runtimes/acp/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SUBAGENT_ROUTING_SETTINGS,
  subagentRoutingSettingsSchema,
  type SubagentRoutingSettings,
} from '@core/features/subagent-routing/api/routing-settings';
import type { ProviderUsage } from '@core/features/usage-limits/api/usage-limits';
import { headroomSampleFromUsage, SubagentRoutingSync } from './routing-sync';

const NOW = Date.UTC(2026, 10, 24, 18, 0, 0);

function usage(providerId: string, usedPercent: number): ProviderUsage {
  return {
    providerId,
    status: 'available',
    windows: [
      {
        label: '5-hour',
        usedPercent: usedPercent / 2,
        resetsAt: new Date(NOW + 3600_000).toISOString(),
      },
      { label: 'weekly', usedPercent, resetsAt: new Date(NOW + 86_400_000).toISOString() },
      // Yenilenmiş pencere yok sayılır.
      { label: 'old', usedPercent: 100, resetsAt: new Date(NOW - 1000).toISOString() },
    ],
    balances: [],
    source: 'test',
    measuredAt: new Date(NOW - 60_000).toISOString(),
    fetchedAt: NOW,
  };
}

describe('headroomSampleFromUsage', () => {
  it('uses the tightest active window', () => {
    expect(headroomSampleFromUsage(usage('codex', 97), NOW)).toEqual({
      remainingPercent: 3,
      windowLabel: 'weekly',
      resetsAt: new Date(NOW + 86_400_000).toISOString(),
      measuredAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(headroomSampleFromUsage(null, NOW)).toBeNull();
    expect(headroomSampleFromUsage({ ...usage('x', 1), windows: [] }, NOW)).toBeNull();
  });
});

describe('SubagentRoutingSync', () => {
  let dir: string;
  let file: string;
  let settings: SubagentRoutingSettings;
  const peek = vi.fn(async (_host: unknown, providers: readonly string[]) =>
    Object.fromEntries(
      providers.map((id) => [id, id === 'codex' ? usage('codex', 97) : usage(id, 20)])
    )
  );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orkestra-routing-sync-'));
    file = join(dir, 'state', 'subagent-routing.json');
    settings = DEFAULT_SUBAGENT_ROUTING_SETTINGS;
    peek.mockClear();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function create() {
    return new SubagentRoutingSync({
      router: runInThisContext(SUBAGENT_ROUTER_EXPRESSION) as SubagentRouter,
      settings: async () => settings,
      usage: { peek },
      snapshotFile: file,
      logger: { warn: vi.fn() },
      now: () => NOW,
      intervalMs: 60 * 60_000,
    });
  }

  it('default settings parse and keep routing off', () => {
    expect(subagentRoutingSettingsSchema.parse(DEFAULT_SUBAGENT_ROUTING_SETTINGS)).toEqual(
      DEFAULT_SUBAGENT_ROUTING_SETTINGS
    );
    expect(DEFAULT_SUBAGENT_ROUTING_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_SUBAGENT_ROUTING_SETTINGS.avoidParentScarceModels).toBe(true);
  });

  it('removes the snapshot while off and writes it while on', async () => {
    await writeFile(join(dir, 'placeholder'), '');
    const sync = create();
    await sync.start();
    await expect(stat(file)).rejects.toThrow();
    expect(peek).not.toHaveBeenCalled();

    settings = { ...DEFAULT_SUBAGENT_ROUTING_SETTINGS, enabled: true };
    await sync.refresh();
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    expect(snapshot).toMatchObject({ version: 1, enabled: true, writtenAt: NOW });
    expect(snapshot.policy.tiers.map((t: { id: string }) => t.id)).toEqual([
      'context',
      'execution',
      'judgment',
    ]);
    expect(snapshot.headroom.codex.remainingPercent).toBe(3);
    // Gemini kullanım verisi yoktur; yalnızca izlenen sağlayıcılar sorulur.
    expect(peek.mock.calls[0]![1]).not.toContain('gemini');

    settings = { ...settings, enabled: false };
    await sync.refresh();
    await expect(stat(file)).rejects.toThrow();
    sync.dispose();
  });

  it('previews headroom and the recommendation per tier', async () => {
    settings = { ...DEFAULT_SUBAGENT_ROUTING_SETTINGS, enabled: true };
    const sync = create();
    await sync.start();
    const preview = await sync.preview();
    expect(preview.enabled).toBe(true);
    expect(preview.writtenAt).toBe(NOW);
    const codexExecution = preview.rows.find(
      (row) => row.tierId === 'execution' && row.provider === 'codex'
    )!;
    expect(codexExecution).toMatchObject({ state: 'low', remainingPercent: 3, recommended: false });
    const recommended = preview.rows.filter((row) => row.recommended).map((row) => row.model);
    expect(recommended).toEqual([
      'gemini-3.8-flash-medium',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]);
    expect(preview.rows.find((row) => row.model === 'claude-fable-5-2')!.scarce).toBe(true);
    sync.dispose();
  });
});
