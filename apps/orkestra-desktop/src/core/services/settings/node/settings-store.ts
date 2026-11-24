import { isDeepEqual } from '@orkestra/shared';
import { eq } from 'drizzle-orm';
import {
  getAtPath,
  ManagedSettingLockedError,
  setAtPath,
  type ManagedSettingsLayer,
} from '@core/primitives/managed-policy/api/managed-settings';
import type { SettingsContribution, SettingsContributionMap } from '@core/primitives/settings/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { appSettings } from '@core/services/app-db/node/schema';
import type { AppSettings, AppSettingsKey, SettingsMeta, SettingsOverrides } from '../api';
import { computeDelta, isPlainObject, mergeDeep } from './utils';

export class SettingsStore {
  private readonly cache: Partial<AppSettings> = {};

  /**
   * @param managed Yönetilen politika katmanı. Politika yoksa `undefined`; o zaman her yol
   * bugünküyle birebir aynıdır.
   */
  constructor(
    private readonly db: AppDb,
    private readonly contributions: SettingsContributionMap<AppSettings>,
    private readonly managed?: ManagedSettingsLayer
  ) {}

  private contribution<K extends AppSettingsKey>(key: K): SettingsContribution<K, AppSettings[K]> {
    return this.contributions[key];
  }

  private getDefault<K extends AppSettingsKey>(key: K): AppSettings[K] {
    const defaults = this.contribution(key).defaults;
    const base = typeof defaults === 'function' ? (defaults as () => AppSettings[K])() : defaults;
    // Politikanın kilitsiz varsayılanları yerleşik varsayılanın yerine geçer.
    return this.managed ? (this.managed.applyDefaults(key, base) as AppSettings[K]) : base;
  }

  /** Kilitli politika değerleri her okumada etkin değerin üzerine konur. */
  private withLocks<K extends AppSettingsKey>(key: K, value: AppSettings[K]): AppSettings[K] {
    return this.managed ? (this.managed.applyLocks(key, value) as AppSettings[K]) : value;
  }

  private assertWritable<K extends AppSettingsKey>(key: K, value: unknown): void {
    if (!this.managed) return;
    const violation = this.managed.findLockViolation(key, value);
    if (violation) throw new ManagedSettingLockedError(this.managed.organization, violation);
  }

  /**
   * Kilitli yollarda kullanıcının daha önce kaydettiği değeri korur: istemcinin geri gönderdiği
   * kilit değeri, politika kalkınca geçerli olacak kullanıcı seçiminin üzerine yazılmamalı.
   */
  private async keepStoredAtLocks<K extends AppSettingsKey>(
    key: K,
    stored: unknown
  ): Promise<unknown> {
    const segments = this.managed?.lockedSegments(key) ?? [];
    if (segments.length === 0) return stored;
    const previous = await this.readRaw(key);
    let next = stored;
    for (const rest of segments) {
      next = setAtPath(next, rest, getAtPath(previous, rest));
    }
    return next;
  }

  private async readRaw(key: AppSettingsKey): Promise<unknown> {
    const [row] = await this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .execute();
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  private async storeRaw(key: AppSettingsKey, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.db
      .insert(appSettings)
      .values({ key, value: serialized })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized } })
      .execute();
  }

  private async deleteRow(key: AppSettingsKey): Promise<void> {
    await this.db.delete(appSettings).where(eq(appSettings.key, key)).execute();
  }

  private effectiveValue<T>(defaults: T, overrides: unknown): T {
    return isPlainObject(defaults) && isPlainObject(overrides)
      ? (mergeDeep(defaults, overrides) as T)
      : overrides === null || overrides === undefined
        ? defaults
        : (overrides as T);
  }

  private parseEffective<K extends AppSettingsKey>(
    key: K,
    raw: unknown,
    defaults: AppSettings[K]
  ): AppSettings[K] {
    const contribution = this.contribution(key);
    const parsed = contribution.schema.safeParse(this.effectiveValue(defaults, raw));
    return parsed.success ? parsed.data : defaults;
  }

  private validate<K extends AppSettingsKey>(key: K, value: AppSettings[K]): AppSettings[K] {
    return this.contribution(key).schema.parse(value);
  }

  async get<K extends AppSettingsKey>(key: K): Promise<AppSettings[K]> {
    if (key in this.cache) return this.cache[key] as AppSettings[K];

    const defaults = this.getDefault(key);
    const raw = await this.readRaw(key);
    const value = this.withLocks(
      key,
      raw === null || raw === undefined ? defaults : this.parseEffective(key, raw, defaults)
    );

    this.cache[key] = value;
    return value;
  }

  async getWithMeta<K extends AppSettingsKey>(key: K): Promise<SettingsMeta<AppSettings[K]>> {
    const defaults = this.withLocks(key, this.getDefault(key));
    const value = await this.get(key);
    let overrides: SettingsOverrides<AppSettings[K]>;
    if (isPlainObject(value) && isPlainObject(defaults)) {
      overrides = computeDelta(value, defaults) as SettingsOverrides<AppSettings[K]>;
    } else {
      overrides = {} as SettingsOverrides<AppSettings[K]>;
    }
    return { value, defaults, overrides };
  }

  async update<K extends AppSettingsKey>(key: K, value: AppSettings[K]): Promise<void> {
    this.assertWritable(key, value);
    const validated = this.validate(key, value);
    const defaults = this.getDefault(key);

    if (this.managed?.lockedSegments(key).some((rest) => rest.length === 0)) {
      // Anahtarın tamamı kilitli: kilit değerini yeniden göndermek kayıtlı seçimi değiştirmez.
      delete this.cache[key];
      return;
    }

    if (isPlainObject(validated) && isPlainObject(defaults)) {
      const delta = (await this.keepStoredAtLocks(
        key,
        computeDelta(validated, defaults)
      )) as Record<string, unknown>;
      if (Object.keys(delta).length === 0) {
        await this.deleteRow(key);
      } else {
        await this.storeRaw(key, delta);
      }
    } else if (isDeepEqual(validated, defaults)) {
      await this.deleteRow(key);
    } else {
      await this.storeRaw(key, validated);
    }

    delete this.cache[key];
  }

  async reset<K extends AppSettingsKey>(key: K): Promise<void> {
    await this.deleteRow(key);
    delete this.cache[key];
  }

  async resetField<K extends AppSettingsKey>(key: K, field: keyof AppSettings[K]): Promise<void> {
    const path = `${key}.${String(field)}`;
    if (this.managed?.isLocked(path)) {
      throw new ManagedSettingLockedError(this.managed.organization, path);
    }
    const defaults = this.getDefault(key);
    const value = await this.get(key);
    if (!isPlainObject(defaults) || !isPlainObject(value)) return;
    const defaultsRecord = defaults as Record<string, unknown>;
    const valueRecord = value as Record<string, unknown>;
    await this.update(key, {
      ...valueRecord,
      [field]: defaultsRecord[field as string],
    } as AppSettings[K]);
  }

  async getAll(): Promise<AppSettings> {
    const keys = Object.keys(this.contributions) as AppSettingsKey[];
    const entries = await Promise.all(keys.map(async (key) => [key, await this.get(key)] as const));
    return Object.fromEntries(entries) as AppSettings;
  }

  async initialize(): Promise<void> {
    await this.getAll();
  }
}
