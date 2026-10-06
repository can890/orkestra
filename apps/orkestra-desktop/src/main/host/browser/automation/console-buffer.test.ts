import { describe, expect, it } from 'vitest';
import { ConsoleBuffer, consoleEntryFromDetails, toConsoleLevel } from './console-buffer';

describe('console entries', () => {
  it('maps Electron 40 and legacy numeric levels', () => {
    expect(toConsoleLevel('warning')).toBe('warning');
    expect(toConsoleLevel('debug')).toBe('debug');
    expect(toConsoleLevel(0)).toBe('debug');
    expect(toConsoleLevel(1)).toBe('info');
    expect(toConsoleLevel(2)).toBe('warning');
    expect(toConsoleLevel(3)).toBe('error');
    expect(toConsoleLevel(undefined)).toBe('info');
  });

  it('builds entries from event details and drops Electron security warnings', () => {
    expect(
      consoleEntryFromDetails(
        {
          level: 'error',
          message: 'Uncaught Error: boom',
          lineNumber: 12,
          sourceId: 'https://a.test/app.js',
        },
        1000
      )
    ).toEqual({
      level: 'error',
      message: 'Uncaught Error: boom',
      line: 12,
      source: 'https://a.test/app.js',
      time: 1000,
    });
    expect(
      consoleEntryFromDetails({ level: 'warning', message: '%cElectron Security Warning x' }, 1)
    ).toBeNull();
    const long = consoleEntryFromDetails({ level: 'info', message: 'x'.repeat(5000) }, 1);
    expect(long?.message.length).toBe(4001);
  });
});

describe('ConsoleBuffer', () => {
  const entry = (time: number, message = `m${time}`) => ({ level: 'info' as const, message, time });

  it('keeps only the most recent entries up to capacity', () => {
    const buffer = new ConsoleBuffer(3);
    for (let index = 1; index <= 5; index++) buffer.push(entry(index));
    expect(buffer.read().map((item) => item.time)).toEqual([3, 4, 5]);
  });

  it('filters by epoch timestamp or relative window, limits and clears', () => {
    let now = 2_000_000_000_000;
    const buffer = new ConsoleBuffer(10, () => now);
    buffer.push(entry(now - 5_000));
    buffer.push(entry(now - 1_000));
    buffer.push(entry(now));
    expect(buffer.read({ sinceMs: now - 1_000 }).length).toBe(2);
    expect(buffer.read({ sinceMs: 2_000 }).length).toBe(2);
    expect(buffer.read({ limit: 1 }).map((item) => item.time)).toEqual([now]);
    expect(buffer.read({ limit: 0 })).toEqual([]);
    expect(buffer.read({ clear: true }).length).toBe(3);
    expect(buffer.read()).toEqual([]);
    now += 1;
  });

  it('finds the latest error after a point in time', () => {
    const buffer = new ConsoleBuffer();
    buffer.push({ level: 'error', message: 'old', time: 1 });
    buffer.push({ level: 'error', message: 'new', time: 10 });
    buffer.push({ level: 'info', message: 'later', time: 11 });
    expect(buffer.latestErrorSince(5)?.message).toBe('new');
    expect(buffer.latestErrorSince(12)).toBeNull();
  });
});
