import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTransport } from '@orkestra/shared/logger/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogHealthService } from './log-health-service';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const VENDOR_TOKEN = `ghp_${'b'.repeat(36)}`;
const tempDirs: string[] = [];
const services: LogHealthService[] = [];

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orkestra-log-health-service-'));
  tempDirs.push(dir);
  return join(dir, 'orkestra.log');
}

function line(message: string, time: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    level: 'warn',
    time: new Date(time).toISOString(),
    proc: 'orkestra-main',
    pid: 42,
    msg: message,
    error: { name: 'SqliteError', message: 'no such column: kind' },
    ...extra,
  })}\n`;
}

function createService(path: string | undefined, reveal = vi.fn()) {
  const service = new LogHealthService({
    host: { logFilePath: () => path, revealInFolder: reveal },
    now: () => NOW,
    sessionStartedAt: NOW - 60_000,
    publishThrottleMs: 0,
  });
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LogHealthService', () => {
  it('açılışta dosyayı tarar, sonra yeni satırları artımlı ekler', async () => {
    const path = await tempLog();
    await writeFile(
      path,
      line('notifications: prune failed', NOW - 2 * 86_400_000) +
        line('notifications: prune failed', NOW - 86_400_000) +
        '{"level":"info","time":"2026-10-06T11:00:00.000Z","msg":"ignored"}\n'
    );
    const service = createService(path);

    await service.refresh();
    let report = service.snapshot();
    expect(report.status).toBe('ready');
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({ count: 2, sessionCount: 0 });

    await appendFile(path, line('notifications: prune failed', NOW - 1000));
    await service.refresh();
    report = service.snapshot();
    expect(report.groups[0]).toMatchObject({ count: 3, sessionCount: 1 });
  });

  it('dosya transport ile yazılmış maskelemeyi korur', async () => {
    const path = await tempLog();
    const transport = createFileTransport({ path });
    transport.write(line(`push failed with ${VENDOR_TOKEN}`, NOW - 1000).trimEnd());
    await transport.flush();

    const service = createService(path);
    await service.refresh();
    const serialized = JSON.stringify(service.snapshot());
    expect(serialized).not.toContain(VENDOR_TOKEN);
    expect(serialized).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('maskelenmeden yazılmış satırları da yayınlamadan önce maskeler', async () => {
    const path = await tempLog();
    await writeFile(path, line(`leak ${VENDOR_TOKEN}`, NOW - 1000, { email: 'a@b.co' }));
    const service = createService(path);
    await service.refresh();
    const serialized = JSON.stringify(service.snapshot());
    expect(serialized).not.toContain(VENDOR_TOKEN);
    expect(serialized).not.toContain('a@b.co');
  });

  it('günlük yolu yoksa unavailable yayınlar ve göstermeyi reddeder', async () => {
    const reveal = vi.fn();
    const service = createService(undefined, reveal);
    await service.refresh();
    expect(service.snapshot().status).toBe('unavailable');
    expect(service.revealLogFile()).toEqual({
      success: false,
      error: 'Günlük dosyası bulunamadı.',
    });
    expect(reveal).not.toHaveBeenCalled();
  });

  it('günlük dosyasını dosya yöneticisinde gösterir', async () => {
    const path = await tempLog();
    const reveal = vi.fn();
    const service = createService(path, reveal);
    expect(service.revealLogFile()).toEqual({ success: true });
    expect(reveal).toHaveBeenCalledWith(path);
  });
});
