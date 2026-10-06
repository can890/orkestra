import { describe, expect, it } from 'vitest';
import { logGroupKey, normalizeErrorSignature, normalizeLogText } from './normalize';

describe('normalizeLogText', () => {
  it('kimlikleri, sayıları, yolları ve URL’leri yer tutuculara indirger', () => {
    expect(
      normalizeLogText(
        'Session 0668f948-d6fd-4c4f-9bb5-2c1a7e8d8938 failed after 1520ms at /Users/[REDACTED_USER]/orkestra/worktrees/x'
      )
    ).toBe('Session <id> failed after <n>ms at <path>');
    expect(normalizeLogText('at file:///Applications/Orkestra.app/a.js:4229:46')).toBe('at <url>');
    expect(normalizeLogText('commit 9de1ccd2 not found')).toBe('commit <hex> not found');
  });

  it('anlamlı kelimeleri ve tek bölümlü yolları korur', () => {
    expect(normalizeLogText('notifications: prune failed')).toBe('notifications: prune failed');
    expect(normalizeLogText('state-expose:attachments/attachments.state')).toBe(
      'state-expose:attachments/attachments.state'
    );
    expect(normalizeLogText('no such column: deadbeef')).toBe('no such column: deadbeef');
  });

  it('boşlukları sadeleştirir ve uzunluğu sınırlar', () => {
    expect(normalizeLogText('  a \n\t b  ')).toBe('a b');
    expect(normalizeLogText('x'.repeat(1000))).toHaveLength(240);
  });
});

describe('normalizeErrorSignature', () => {
  it('ad, normalleştirilmiş mesaj ve kodu birleştirir', () => {
    expect(
      normalizeErrorSignature({
        name: 'SqliteError',
        message: 'no such table: t_42',
        code: 'SQLITE_ERROR',
      })
    ).toBe('SqliteError: no such table: t_<n> [SQLITE_ERROR]');
    expect(normalizeErrorSignature({ name: 'Error', message: null })).toBe('Error');
    expect(normalizeErrorSignature(undefined)).toBeNull();
  });
});

describe('logGroupKey', () => {
  it('aynı girdi için kararlı, farklı seviye için farklıdır', () => {
    const a = logGroupKey('warn', 'prune failed', 'SqliteError: x');
    expect(a).toBe(logGroupKey('warn', 'prune failed', 'SqliteError: x'));
    expect(a).not.toBe(logGroupKey('error', 'prune failed', 'SqliteError: x'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
