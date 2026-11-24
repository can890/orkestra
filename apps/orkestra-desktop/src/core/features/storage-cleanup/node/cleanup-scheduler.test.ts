import { describe, expect, it } from 'vitest';
import {
  DISABLED_WORKTREE_RULES,
  DEFAULT_STORAGE_CLEANUP_SETTINGS,
  anyCleanupPolicyEnabled,
  resolveWorktreeRules,
  storageCleanupSettingsSchema,
} from '../api/settings';
import { CleanupScheduler, HOURLY_MS, type SchedulerTimers } from './cleanup-scheduler';

/** Elle ilerletilen sahte saat: zamanlayıcılar yalnızca `advance` ile tetiklenir. */
class FakeClock implements SchedulerTimers {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await Promise.resolve();
    }
    this.now = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

describe('CleanupScheduler', () => {
  it('runs at startup and then every hour', async () => {
    const clock = new FakeClock();
    const runs: Array<{ trigger: string; at: number }> = [];
    const scheduler = new CleanupScheduler({
      run: async (trigger) => {
        runs.push({ trigger, at: clock.now });
      },
      timers: clock,
    });
    scheduler.start();
    await scheduler.idle();
    expect(runs).toEqual([{ trigger: 'startup', at: 0 }]);
    await clock.advance(HOURLY_MS - 1);
    await scheduler.idle();
    expect(runs).toHaveLength(1);
    await clock.advance(1);
    await scheduler.idle();
    await clock.advance(HOURLY_MS);
    await scheduler.idle();
    expect(runs).toEqual([
      { trigger: 'startup', at: 0 },
      { trigger: 'hourly', at: HOURLY_MS },
      { trigger: 'hourly', at: 2 * HOURLY_MS },
    ]);
    scheduler.dispose();
    expect(clock.pending).toBe(0);
  });

  it('can delay the startup run', async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    const scheduler = new CleanupScheduler({
      run: async (trigger) => {
        runs.push(trigger);
      },
      timers: clock,
      startupDelayMs: 30_000,
    });
    scheduler.start();
    await scheduler.idle();
    expect(runs).toEqual([]);
    await clock.advance(30_000);
    await scheduler.idle();
    expect(runs).toEqual(['startup']);
    scheduler.dispose();
  });

  it('debounces policy changes into a single run', async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    const scheduler = new CleanupScheduler({
      run: async (trigger) => {
        runs.push(trigger);
      },
      timers: clock,
      debounceMs: 2_000,
    });
    scheduler.settingsChanged();
    await clock.advance(1_000);
    scheduler.settingsChanged();
    await clock.advance(1_999);
    await scheduler.idle();
    expect(runs).toEqual([]);
    await clock.advance(1);
    await scheduler.idle();
    expect(runs).toEqual(['settings']);
    scheduler.dispose();
  });

  it('never overlaps runs; a trigger during a run runs once afterwards', async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | null = null;
    const scheduler = new CleanupScheduler({
      run: async (trigger) => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs.push(trigger);
        if (trigger === 'startup') await new Promise<void>((resolve) => (release = resolve));
        active--;
      },
      timers: clock,
      debounceMs: 0,
    });
    scheduler.start();
    scheduler.settingsChanged();
    await clock.advance(0);
    scheduler.settingsChanged();
    await clock.advance(0);
    expect(runs).toEqual(['startup']);
    release!();
    await scheduler.idle();
    expect(runs).toEqual(['startup', 'settings']);
    expect(maxActive).toBe(1);
    scheduler.dispose();
  });

  it('keeps running after a failed run', async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = new CleanupScheduler({
      run: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      timers: clock,
      onError: (error) => errors.push(error),
    });
    scheduler.start();
    await scheduler.idle();
    await clock.advance(HOURLY_MS);
    await scheduler.idle();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    scheduler.dispose();
  });
});

describe('storage cleanup settings', () => {
  it('is off by default and validates retention bounds', () => {
    expect(anyCleanupPolicyEnabled(DEFAULT_STORAGE_CLEANUP_SETTINGS)).toBe(false);
    expect(storageCleanupSettingsSchema.safeParse(DEFAULT_STORAGE_CLEANUP_SETTINGS).success).toBe(
      true
    );
    expect(
      storageCleanupSettingsSchema.safeParse({
        ...DEFAULT_STORAGE_CLEANUP_SETTINGS,
        worktrees: { ...DISABLED_WORKTREE_RULES, inactiveDays: 0 },
      }).success
    ).toBe(false);
    expect(
      storageCleanupSettingsSchema.safeParse({
        ...DEFAULT_STORAGE_CLEANUP_SETTINGS,
        worktrees: { ...DISABLED_WORKTREE_RULES, settledDays: 0 },
      }).success
    ).toBe(true);
  });

  it('resolves Inherit / Off / Custom per project', () => {
    const settings = {
      ...DEFAULT_STORAGE_CLEANUP_SETTINGS,
      worktrees: { ...DISABLED_WORKTREE_RULES, inactiveDays: 7 },
      projectOverrides: {
        off: { mode: 'off' as const },
        custom: {
          mode: 'custom' as const,
          rules: { ...DISABLED_WORKTREE_RULES, onMerge: true },
        },
        empty: { mode: 'custom' as const, rules: DISABLED_WORKTREE_RULES },
      },
    };
    expect(resolveWorktreeRules(settings, 'inherit')?.inactiveDays).toBe(7);
    expect(resolveWorktreeRules(settings, 'off')).toBeNull();
    expect(resolveWorktreeRules(settings, 'custom')).toMatchObject({
      inactiveDays: null,
      onMerge: true,
    });
    expect(resolveWorktreeRules(settings, 'empty')).toBeNull();
    expect(
      anyCleanupPolicyEnabled({
        ...DEFAULT_STORAGE_CLEANUP_SETTINGS,
        projectOverrides: settings.projectOverrides,
      })
    ).toBe(true);
  });
});
