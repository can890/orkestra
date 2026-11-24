// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/policy/managedSettings.ts
//
// Politikanın `settings` bölümünü uygulama ayarlarına uygular. Politika değerleri kullanıcının
// kayıtlı ayarlarına asla yazılmaz: kilitsiz değerler yerleşik varsayılanın yerine geçer, kilitli
// değerler her okumada sonucun üzerine konur. Politika kaldırılınca kullanıcının kendi seçimleri
// geri gelir.
import { isDeepEqual } from '@orkestra/shared';
import {
  clampPermissionMode,
  isLockedSettingPath,
  type ManagedPermissionMode,
  type ValidatedManagedPolicy,
} from '@orkestra/shared/managed-policy';

type Segments = readonly string[];

/** Ayar deposunun (SettingsStore) gördüğü dar yüzey. */
export interface ManagedSettingsLayer {
  readonly organization: string;
  /** Kullanıcının değiştiremeyeceği tam yollar (`tasks.defaultPermissionMode`). */
  readonly lockedPaths: readonly string[];
  /** Yerleşik varsayılanların üzerine politikanın kilitsiz varsayılanlarını koyar. */
  applyDefaults(key: string, defaults: unknown): unknown;
  /** Kilitli değerleri ve izin tavanını etkin değerin üzerine koyar. */
  applyLocks(key: string, value: unknown): unknown;
  /** Anahtar altındaki kilitli alt yollar (`[]`: anahtarın tamamı kilitli). */
  lockedSegments(key: string): readonly Segments[];
  /** Kilitli bir yolu kilit değerinden uzaklaştıran yazım reddedilir; reddedilen yolu döner. */
  findLockViolation(key: string, next: unknown): string | null;
  isLocked(path: string): boolean;
}

export class ManagedSettingLockedError extends Error {
  constructor(
    readonly organization: string,
    readonly path: string
  ) {
    super(`${organization} manages the "${path}" setting; it cannot be changed.`);
    this.name = 'ManagedSettingLockedError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function getAtPath(tree: unknown, segments: Segments): unknown {
  let current = tree;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Değişmez kopya üretir; `value === undefined` yaprağı siler. */
export function setAtPath(tree: unknown, segments: Segments, value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  const record = isRecord(tree) ? tree : {};
  if (value === undefined && rest.length === 0) {
    const { [head]: _removed, ...remaining } = record;
    return remaining;
  }
  return { ...record, [head]: setAtPath(record[head], rest, value) };
}

function entriesFor(
  entries: ReadonlyMap<string, unknown>,
  key: string
): Array<{ path: string; rest: Segments; value: unknown }> {
  const result: Array<{ path: string; rest: Segments; value: unknown }> = [];
  for (const [path, value] of entries) {
    const [head, ...rest] = path.split('.');
    if (head === key) result.push({ path, rest, value });
  }
  return result;
}

/**
 * İzin tavanı, kullanıcının kayıtlı varsayılanını değiştirmeden etkin varsayılanı daraltır:
 * tavanın üzerindeki varsayılan mod tavana iner, tavan `bypass` değilse "varsayılan olarak
 * otomatik onayla" kapanır. Politika kaldırılınca kayıtlı değer geri gelir.
 */
function clampTaskDefaults(value: unknown, ceiling: ManagedPermissionMode | undefined): unknown {
  if (ceiling === undefined || !isRecord(value)) return value;
  let next = value;
  const mode = value.defaultPermissionMode;
  if (typeof mode === 'string') {
    const clamped = clampPermissionMode(mode as ManagedPermissionMode, ceiling);
    if (clamped !== mode) next = { ...next, defaultPermissionMode: clamped };
  }
  if (ceiling !== 'bypass' && value.autoApproveByDefault === true) {
    next = { ...next, autoApproveByDefault: false };
  }
  return next;
}

export function createManagedSettingsLayer(policy: ValidatedManagedPolicy): ManagedSettingsLayer {
  const organization = policy.document.organization;
  const ceiling = policy.document.limits?.maxPermissionMode;
  const lockedPaths = [...policy.lockedSettings.keys()];

  return {
    organization,
    lockedPaths,
    applyDefaults(key, defaults) {
      let next = defaults;
      for (const entry of entriesFor(policy.defaultSettings, key)) {
        next = setAtPath(next, entry.rest, entry.value);
      }
      return next;
    },
    applyLocks(key, value) {
      let next = value;
      for (const entry of entriesFor(policy.lockedSettings, key)) {
        next = setAtPath(next, entry.rest, entry.value);
      }
      return key === 'tasks' ? clampTaskDefaults(next, ceiling) : next;
    },
    lockedSegments(key) {
      return entriesFor(policy.lockedSettings, key).map((entry) => entry.rest);
    },
    findLockViolation(key, next) {
      for (const entry of entriesFor(policy.lockedSettings, key)) {
        const candidate = getAtPath(next, entry.rest);
        // Bir alt anahtarı hiç taşımayan yama kilidi değiştirmez.
        if (candidate === undefined && entry.rest.length > 0) continue;
        if (!isDeepEqual(candidate, entry.value)) return entry.path;
      }
      if (key === 'tasks' && ceiling !== undefined && isRecord(next)) {
        // Tavanın üzerindeki bir varsayılan, kilit olmasa da yazılamaz.
        if (!isDeepEqual(clampTaskDefaults(next, ceiling), next)) {
          return next.autoApproveByDefault === true && ceiling !== 'bypass'
            ? 'tasks.autoApproveByDefault'
            : 'tasks.defaultPermissionMode';
        }
      }
      return null;
    },
    isLocked(path) {
      return isLockedSettingPath(lockedPaths, path);
    },
  };
}
