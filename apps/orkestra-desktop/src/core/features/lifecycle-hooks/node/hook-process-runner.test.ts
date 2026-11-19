import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalHookProcessRunner } from './hook-process-runner';

const posix = process.platform !== 'win32';

/** Gerçek süreçle yalnızca os.tmpdir() içinde zararsız komutlar (cat, true, sleep). */
describe.skipIf(!posix)('createLocalHookProcessRunner (gerçek süreç)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanca-runner-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, SHELL: '/bin/sh' });
  const runner = () => createLocalHookProcessRunner({ cwd: dir });

  it('stdin JSON’unu komuta iletir ve çıkış kodunu döner', async () => {
    const out = path.join(dir, 'stdin.json');
    const payload = JSON.stringify({ prompt: '"; touch pwned #' });
    const result = await runner()({
      command: `cat > ${out}`,
      env: env(),
      stdin: payload,
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await fs.readFile(out, 'utf8')).toBe(payload);
    await expect(fs.stat(path.join(dir, 'pwned'))).rejects.toThrow();
  });

  it('env değişkenlerini komuta verir; stdout/stderr kuyruğunu toplar', async () => {
    const result = await runner()({
      command: 'echo "$ORKESTRA_HOOK_EVENT"; echo hata >&2; exit 3',
      env: { ...env(), ORKESTRA_HOOK_EVENT: 'task.created' },
      stdin: '{}',
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe('task.created');
    expect(result.stderr.trim()).toBe('hata');
  });

  it('shellSetup komuttan önce çalışır', async () => {
    const result = await runner()({
      command: 'echo "$KURULUM"',
      shellSetup: 'export KURULUM=hazir',
      env: env(),
      stdin: '',
      timeoutMs: 10_000,
    });
    expect(result.stdout.trim()).toBe('hazir');
  });

  it('true komutu 0 ile biter', async () => {
    const result = await runner()({ command: 'true', env: env(), stdin: '', timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
  });

  it('zaman aşımı dolunca süreç sonlandırılır', async () => {
    const started = Date.now();
    const result = await runner()({
      command: 'sleep 30',
      env: env(),
      stdin: '',
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stdin’i okumayan komut EPIPE ile çökertmez', async () => {
    const result = await runner()({
      command: 'true',
      env: env(),
      stdin: 'x'.repeat(1_000_000),
      timeoutMs: 10_000,
    });
    expect(result.timedOut).toBe(false);
  });
});
