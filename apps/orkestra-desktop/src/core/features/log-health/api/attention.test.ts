import { describe, expect, it } from 'vitest';
import { boundPreferenceMap, needsAttention, type LogHealthPreferences } from './attention';
import type { LogHealthGroup } from './contract';

const SESSION = 1_000_000;
const NONE: LogHealthPreferences = { ignored: {}, acknowledged: {} };

function group(overrides: Partial<LogHealthGroup> = {}): LogHealthGroup {
  return {
    key: 'k1',
    level: 'warn',
    template: 'prune failed',
    errorSignature: null,
    count: 1,
    sessionCount: 1,
    launchCount: 1,
    dayCount: 1,
    firstSeen: 0,
    lastSeen: 0,
    processes: [],
    example: {
      time: '',
      proc: null,
      message: '',
      errorName: null,
      errorMessage: null,
      stack: null,
      fields: null,
    },
    ...overrides,
  };
}

describe('needsAttention', () => {
  it('bu oturumda üç kez tekrarlayan yeni grubu işaretler', () => {
    expect(needsAttention(group({ sessionCount: 2 }), NONE, SESSION)).toBe(false);
    expect(needsAttention(group({ sessionCount: 3 }), NONE, SESSION)).toBe(true);
  });

  it('her açılışta bir kez düşen sessiz uyarıyı da yakalar', () => {
    expect(needsAttention(group({ launchCount: 3 }), NONE, SESSION)).toBe(true);
    expect(needsAttention(group({ dayCount: 3 }), NONE, SESSION)).toBe(true);
  });

  it('yok sayılan grubu hiç işaretlemez', () => {
    const prefs = { ignored: { k1: 1 }, acknowledged: {} };
    expect(needsAttention(group({ sessionCount: 10 }), prefs, SESSION)).toBe(false);
  });

  it('görülen grubu yalnızca sonraki bir oturumda üç tekrarda yeniden işaretler', () => {
    const seenThisSession = { ignored: {}, acknowledged: { k1: SESSION + 1 } };
    expect(
      needsAttention(group({ sessionCount: 5, launchCount: 9 }), seenThisSession, SESSION)
    ).toBe(false);
    const seenEarlier = { ignored: {}, acknowledged: { k1: SESSION - 1 } };
    expect(needsAttention(group({ sessionCount: 2, launchCount: 9 }), seenEarlier, SESSION)).toBe(
      false
    );
    expect(needsAttention(group({ sessionCount: 3 }), seenEarlier, SESSION)).toBe(true);
  });
});

describe('boundPreferenceMap', () => {
  it('en yeni kayıtları tutar', () => {
    expect(boundPreferenceMap({ a: 1, b: 3, c: 2 }, 2)).toEqual({ b: 3, c: 2 });
    expect(boundPreferenceMap({ a: 1 }, 2)).toEqual({ a: 1 });
  });
});
