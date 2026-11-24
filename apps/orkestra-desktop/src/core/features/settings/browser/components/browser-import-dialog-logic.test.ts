import { describe, expect, it } from 'vitest';
import type { BrowserImportSource } from '@core/features/browser/api/browser-import';
import {
  canStartImport,
  outcomeToStep,
  preferredSourceId,
  selectableSources,
  summaryLines,
} from './browser-import-dialog-logic';

const source = (overrides: Partial<BrowserImportSource>): BrowserImportSource => ({
  id: 'chrome',
  name: 'Google Chrome',
  engine: 'chromium',
  profiles: [{ directory: 'Default', name: 'Personal', cookieCount: 3 }],
  ...overrides,
});

describe('browser import dialog logic', () => {
  it('prefers a ready source, then one that needs an action', () => {
    expect(
      preferredSourceId([
        source({ id: 'brave', unavailable: 'notInstalled', profiles: [] }),
        source({ id: 'safari', unavailable: 'needsFullDiskAccess', profiles: [] }),
        source({ id: 'firefox' }),
      ])
    ).toBe('firefox');
    expect(
      preferredSourceId([
        source({ id: 'brave', unavailable: 'notInstalled', profiles: [] }),
        source({ id: 'safari', unavailable: 'needsFullDiskAccess', profiles: [] }),
      ])
    ).toBe('safari');
  });

  it('hides browsers that are not installed', () => {
    expect(
      selectableSources([
        source({ id: 'brave', unavailable: 'notInstalled' }),
        source({ id: 'chrome', unavailable: 'browserRunning' }),
      ]).map((s) => s.id)
    ).toEqual(['chrome']);
  });

  it('only enables import for a ready source, a listed profile and a target', () => {
    const ready = source({});
    const existing = { kind: 'existing' as const, profileId: 'default' };
    expect(
      canStartImport({ source: ready, sourceProfileDirectory: 'Default', target: existing })
    ).toBe(true);
    expect(
      canStartImport({ source: ready, sourceProfileDirectory: 'Other', target: existing })
    ).toBe(false);
    expect(
      canStartImport({
        source: source({ unavailable: 'browserRunning' }),
        sourceProfileDirectory: 'Default',
        target: existing,
      })
    ).toBe(false);
    expect(
      canStartImport({
        source: ready,
        sourceProfileDirectory: 'Default',
        target: { kind: 'new', name: '  ' },
      })
    ).toBe(false);
  });

  it('turns results into steps and count-only summary lines', () => {
    const summary = {
      imported: 5,
      skipped: 3,
      skippedExpired: 1,
      skippedPartitioned: 2,
      skippedUndecryptable: 0,
      skippedRejected: 0,
      skippedDomains: ['a.test'],
    };
    expect(outcomeToStep({ success: true, summary }, 'Work')).toEqual({
      step: 'done',
      summary,
      targetProfileName: 'Work',
    });
    expect(outcomeToStep({ success: false, reason: 'browserRunning' }, 'Work')).toEqual({
      step: 'failed',
      reason: 'browserRunning',
    });
    expect(summaryLines(summary)).toEqual([
      'Imported 5 cookies.',
      'Skipped 1 expired cookies.',
      'Skipped 2 partitioned or container cookies.',
    ]);
  });
});
