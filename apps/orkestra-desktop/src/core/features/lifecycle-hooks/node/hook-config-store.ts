import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { secret } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  emptyLifecycleHooksConfig,
  lifecycleHooksConfig,
  validateLifecycleHooksConfig,
  type LifecycleHooksConfig,
} from '../api/hook-config';

export const LIFECYCLE_HOOKS_FILE = 'lifecycle-hooks.json';
export const INTEGRITY_KEY_SECRET = 'lifecycle-hooks.integrity-key';

export type HookConfigStatus =
  /** Yapılandırma doğrulandı ya da hiç yazılmadı (varsayılan: kanca yok). */
  | 'ok'
  /** Dosya bütünlük doğrulamasından geçmedi (uygulama dışında değiştirilmiş); yok sayıldı. */
  | 'tampered'
  /** Dosya okunamadı/ayrıştırılamadı; yok sayıldı. */
  | 'invalid'
  /** Daha yeni bir uygulama sürümü yazmış; yok sayıldı. */
  | 'future-version'
  /** Güvenli depolama yok: bütünlük anahtarı alınamadığı için kancalar kapalı. */
  | 'unavailable';

export type HookConfigSnapshot = Readonly<{
  config: LifecycleHooksConfig;
  status: HookConfigStatus;
}>;

type Envelope = { config: unknown; integrity: unknown };

/**
 * Kanca tanımlarının host-yerel sürümlü JSON dosyası. Dosyadaki her yapılandırma, anahtarı
 * şifreli uygulama secret deposunda duran bir HMAC ile mühürlenir: bir ajan (ya da başka bir
 * süreç) dosyayı doğrudan düzenlese bile mühür tutmaz ve yapılandırma yok sayılır (kancalar
 * kapalı). Okuma yalnızca başlangıçta yapılır; çalışma sırasında dosya değişiklikleri etkisizdir.
 * Bu modül depo dosyalarını (`.orkestra.json` vb.) hiçbir zaman okumaz.
 */
export class HookConfigStore {
  private snapshot: HookConfigSnapshot = { config: emptyLifecycleHooksConfig(), status: 'ok' };
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      /** Mutlak dosya yolu (userData altında). */
      filePath: string;
      secrets: SecretStore;
      logger: Pick<Logger, 'warn'>;
    }
  ) {
    if (!path.isAbsolute(options.filePath)) {
      throw new Error('HookConfigStore için mutlak dosya yolu gerekir');
    }
  }

  get(): HookConfigSnapshot {
    return this.snapshot;
  }

  /** Başlangıçta bir kez çağrılır. Asla fırlatmaz; sorunlarda kancalar kapalı kalır. */
  async load(): Promise<HookConfigSnapshot> {
    let raw: string;
    try {
      raw = await fs.readFile(this.options.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.logger.warn('Kanca yapılandırması okunamadı', { error: String(error) });
        this.snapshot = { config: emptyLifecycleHooksConfig(), status: 'invalid' };
      } else {
        this.snapshot = { config: emptyLifecycleHooksConfig(), status: 'ok' };
      }
      return this.snapshot;
    }
    this.snapshot = await this.verify(raw);
    return this.snapshot;
  }

  /** Doğrulanmış yapılandırmayı mühürleyip yazar ve bellekteki kopyayı günceller. */
  async save(
    input: unknown
  ): Promise<{ success: true; snapshot: HookConfigSnapshot } | { success: false; error: string }> {
    const validated = validateLifecycleHooksConfig(input);
    if (!validated.success) return validated;
    const config = validated.config;
    const run = this.writeChain.then(async () => {
      let key: string;
      try {
        key = await this.getOrCreateKey();
      } catch (error) {
        this.options.logger.warn('Kanca bütünlük anahtarı alınamadı', { error: String(error) });
        return {
          success: false as const,
          error: 'Güvenli depolama kullanılamıyor; kancalar kaydedilemedi',
        };
      }
      const envelope = { config, integrity: sign(key, config) };
      await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
      const tmp = `${this.options.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, this.options.filePath);
      this.snapshot = { config, status: 'ok' };
      return { success: true as const, snapshot: this.snapshot };
    });
    this.writeChain = run.catch(() => undefined);
    try {
      return await run;
    } catch (error) {
      this.options.logger.warn('Kanca yapılandırması yazılamadı', { error: String(error) });
      return { success: false, error: 'Yapılandırma dosyası yazılamadı' };
    }
  }

  private async verify(raw: string): Promise<HookConfigSnapshot> {
    const empty = (status: HookConfigStatus): HookConfigSnapshot => ({
      config: emptyLifecycleHooksConfig(),
      status,
    });
    let envelope: Envelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return empty('invalid');
      }
      envelope = parsed as Envelope;
    } catch {
      return empty('invalid');
    }

    let key: string | null;
    try {
      key = await this.readKey();
    } catch (error) {
      this.options.logger.warn('Kanca bütünlük anahtarı okunamadı', { error: String(error) });
      return empty('unavailable');
    }
    if (key === null || typeof envelope.integrity !== 'string') return empty('tampered');
    if (!macEquals(sign(key, envelope.config), envelope.integrity)) return empty('tampered');

    const parsed = lifecycleHooksConfig.safeParse(envelope.config);
    if (parsed.status === 'future-version') return empty('future-version');
    if (parsed.status !== 'ok') return empty('invalid');
    // Üretimde sürümlü şema yeniden doğrulamaz; kural doğrulaması burada da uygulanır.
    const validated = validateLifecycleHooksConfig(parsed.data);
    return validated.success ? { config: validated.config, status: 'ok' } : empty('invalid');
  }

  private async readKey(): Promise<string | null> {
    const stored = await this.options.secrets.getSecret(INTEGRITY_KEY_SECRET);
    return stored ? stored.expose() : null;
  }

  private async getOrCreateKey(): Promise<string> {
    const existing = await this.readKey();
    if (existing) return existing;
    const created = randomBytes(32).toString('hex');
    await this.options.secrets.setSecret(
      INTEGRITY_KEY_SECRET,
      secret(created, INTEGRITY_KEY_SECRET)
    );
    return created;
  }
}

function sign(key: string, config: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(config)).digest('hex');
}

function macEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
