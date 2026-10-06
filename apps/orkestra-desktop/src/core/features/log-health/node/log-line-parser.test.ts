import { describe, expect, it } from 'vitest';
import { isCandidateLogLine, parseLogLine } from './log-line-parser';

describe('parseLogLine', () => {
  it('pino warn satırını ayrıştırır (yinelenen anahtarlarda sonuncusu kazanır)', () => {
    const line =
      '{"level":"warn","time":"2026-10-04T20:09:19.681Z","proc":"orkestra-main","pid":1,"worker":"acp","proc":"acp","pid":2,"msg":"notifications: prune failed","error":{"name":"SqliteError","message":"no such column: x","stack":"SqliteError: no such column: x\\n    at a","code":"SQLITE_ERROR"}}';
    const entry = parseLogLine(line);
    expect(entry).toMatchObject({
      level: 'warn',
      time: Date.parse('2026-10-04T20:09:19.681Z'),
      proc: 'acp',
      pid: 2,
      message: 'notifications: prune failed',
      error: { name: 'SqliteError', message: 'no such column: x', code: 'SQLITE_ERROR' },
      extra: { worker: 'acp' },
    });
  });

  it('renderer satırında mesajı data[0], hatayı data argümanlarından alır', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-05T22:40:28.341Z',
      level: 'error',
      source: 'renderer',
      message: 'Failed to refresh ACP history {"conversationId":"c1"}',
      data: [
        'Failed to refresh ACP history',
        {
          conversationId: 'c1',
          error: { name: 'WireError', message: 'Wire transport disconnected' },
        },
      ],
    });
    expect(parseLogLine(line)).toMatchObject({
      level: 'error',
      proc: 'renderer',
      pid: null,
      message: 'Failed to refresh ACP history',
      error: { name: 'WireError', message: 'Wire transport disconnected' },
      extra: { conversationId: 'c1' },
    });
  });

  it('sayısal pino seviyelerini anlar', () => {
    expect(parseLogLine('{"level":50,"time":1700000000000,"msg":"boom"}')?.level).toBe('error');
    expect(parseLogLine('{"level":60,"time":1700000000000,"msg":"boom"}')?.level).toBe('fatal');
  });

  it('info/debug, bozuk ve zamansız satırları yok sayar', () => {
    expect(
      parseLogLine('{"level":"info","time":"2026-10-04T20:09:19.681Z","msg":"ok"}')
    ).toBeNull();
    expect(parseLogLine('{"level":"warn","time":"2026-10-04T20:0')).toBeNull();
    expect(parseLogLine('{"level":"warn","msg":"no time"}')).toBeNull();
    expect(parseLogLine('plain text warn')).toBeNull();
  });

  it('ön eleme yalnızca uyarı/hata seviyelerini aday sayar', () => {
    expect(isCandidateLogLine('{"level":"warn"}')).toBe(true);
    expect(isCandidateLogLine('{"level": 40}')).toBe(true);
    expect(isCandidateLogLine('{"level":"info","msg":"level warn"}')).toBe(false);
  });
});
