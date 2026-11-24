// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/shared/src/managedPolicyFile.ts
//
// Politikayı işletim sistemine özgü sistem konumlarından okur. Kaynaklar birleştirilmez: aynı
// makinede hem yapılandırma profili hem politika dosyası varsa başlatma reddedilir.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stableStringify } from '../../util/stable-stringify';
import { describeManagedPolicyLines, summarizeManagedPolicy } from '../describe';
import type { ManagedPolicySummary } from '../schema';
import {
  formatManagedPolicyError,
  validateManagedPolicy,
  type ManagedPolicyValidationError,
  type ValidatedManagedPolicy,
} from '../validate';

/** macOS: yöneticinin dağıttığı politika dosyası. */
export const MACOS_MANAGED_POLICY_FILE = '/Library/Application Support/Orkestra/policy.json';
/** macOS: yapılandırma profili (`com.orkestra.policy` tercih alanı) kurulduğunda yazılan dosya. */
export const MACOS_MANAGED_PREFERENCES_DOMAIN = 'com.orkestra.policy';
export const MACOS_MANAGED_PREFERENCES_FILE = `/Library/Managed Preferences/${MACOS_MANAGED_PREFERENCES_DOMAIN}.plist`;
/** Linux (ve diğer POSIX sistemler). */
export const LINUX_MANAGED_POLICY_FILE = '/etc/orkestra/policy.json';
/** Windows: kullanıcıların oluşturamayacağı bir yönetici dizini. */
export const WINDOWS_MANAGED_POLICY_FILE = 'C:\\Program Files\\Orkestra\\policy.json';

/**
 * Test ve geliştirme için yol geçersiz kılma. Yalnızca çağıran izin verdiğinde (kaynaktan
 * çalışan derlemeler) okunur: yayın derlemesinde kullanıcının ayarlayabildiği her geçersiz
 * kılma, politikayı atlatmanın bir yolu olurdu.
 */
export const MANAGED_POLICY_PATH_ENV = 'ORKESTRA_MANAGED_POLICY_PATH';

// Mutlak yol: PATH'te öne konan sahte bir `plutil` "politika yok" diyemesin.
const PLUTIL = '/usr/bin/plutil';

export type LoadedManagedPolicy = {
  source: string;
  fingerprint: string;
  policy: ValidatedManagedPolicy;
  summary: ManagedPolicySummary;
};

export type ManagedPolicyLoadResult =
  | { kind: 'none'; searched: string[] }
  | { kind: 'loaded'; loaded: LoadedManagedPolicy }
  | { kind: 'error'; error: ManagedPolicyValidationError; message: string };

export type ManagedPolicyFs = {
  /** Dosya yoksa `undefined`, başka bir okuma hatasında hata fırlatır. */
  readText(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
};

export type ReadManagedPolicyOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** `ORKESTRA_MANAGED_POLICY_PATH` dikkate alınsın mı (yalnızca kaynak/geliştirme derlemeleri). */
  allowPathOverride?: boolean;
  knownProviderIds?: readonly string[];
  fs?: ManagedPolicyFs;
  /** macOS profilini JSON'a çevirir; varsayılan `/usr/bin/plutil`. */
  convertPlistToJson?: (path: string) => Promise<string>;
};

export const nodeManagedPolicyFs: ManagedPolicyFs = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
};

/** Platform için politika dosyasının sistem yolu. */
export function managedPolicyFilePath(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return MACOS_MANAGED_POLICY_FILE;
    case 'win32':
      return WINDOWS_MANAGED_POLICY_FILE;
    default:
      return LINUX_MANAGED_POLICY_FILE;
  }
}

/** `policy show` için: politikayı belirleyen kanonik JSON'un kısa SHA-256 özeti. */
export function managedPolicyFingerprint(policy: ValidatedManagedPolicy): string {
  return createHash('sha256').update(stableStringify(policy.document)).digest('hex').slice(0, 12);
}

/** Tek bir JSON dosyasını okuyup doğrular; dosya yoksa `none` döner. */
export async function loadManagedPolicyFile(
  path: string,
  options: Pick<ReadManagedPolicyOptions, 'fs' | 'knownProviderIds'> = {}
): Promise<ManagedPolicyLoadResult> {
  const fs = options.fs ?? nodeManagedPolicyFs;
  let text: string | undefined;
  try {
    text = await fs.readText(path);
  } catch (error) {
    return failure(path, `the file cannot be read (${describeError(error)})`);
  }
  if (text === undefined) return { kind: 'none', searched: [path] };
  return fromRaw(text, path, options.knownProviderIds);
}

/**
 * Bu makinedeki politikayı okur. Politika yoksa `none` (davranış bugünkünün aynısı), geçersizse
 * `error` döner: çağıran fail-closed davranmalı ve başlamamalıdır.
 */
export async function readManagedPolicy(
  options: ReadManagedPolicyOptions = {}
): Promise<ManagedPolicyLoadResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeManagedPolicyFs;

  const override = options.allowPathOverride ? env[MANAGED_POLICY_PATH_ENV]?.trim() : undefined;
  if (override) {
    return loadManagedPolicyFile(override, { fs, knownProviderIds: options.knownProviderIds });
  }

  const filePath = managedPolicyFilePath(platform);
  const searched = [filePath];
  let profile: ManagedPolicyLoadResult | undefined;
  if (platform === 'darwin') {
    searched.unshift(MACOS_MANAGED_PREFERENCES_FILE);
    profile = await readMacProfile(fs, options);
    if (profile?.kind === 'error') return profile;
  }

  const file = await loadManagedPolicyFile(filePath, {
    fs,
    knownProviderIds: options.knownProviderIds,
  });
  if (file.kind === 'error') return file;

  if (profile?.kind === 'loaded' && file.kind === 'loaded') {
    return failure(
      filePath,
      `a configuration profile (${MACOS_MANAGED_PREFERENCES_FILE}) also sets a policy; remove one of them`
    );
  }
  if (profile?.kind === 'loaded') return profile;
  if (file.kind === 'loaded') return file;
  return { kind: 'none', searched };
}

/** `policy check`/`show` metni. */
export function describeLoadedManagedPolicy(loaded: LoadedManagedPolicy): string {
  return `${describeManagedPolicyLines(loaded.policy, loaded).join('\n')}\n`;
}

async function readMacProfile(
  fs: ManagedPolicyFs,
  options: ReadManagedPolicyOptions
): Promise<ManagedPolicyLoadResult | undefined> {
  const path = MACOS_MANAGED_PREFERENCES_FILE;
  try {
    if (!(await fs.exists(path))) return undefined;
  } catch (error) {
    return failure(path, `the profile cannot be checked (${describeError(error)})`);
  }
  let json: string;
  try {
    json = await (options.convertPlistToJson ?? convertWithPlutil)(path);
  } catch (error) {
    return failure(path, `the profile cannot be read (${describeError(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return failure(path, 'the profile cannot be converted to JSON');
  }
  return fromRaw(unwrapProfile(parsed), path, options.knownProviderIds);
}

// macOS, profilin kendi anahtarlarının yanına `PayloadUUID` ve `_manualProfile` yazar; hiçbir
// politika anahtarı `Payload` ya da `_` ile başlamadığından bunları atmak bir kısıtlamayı gizlemez.
// MCX tarzı profiller anahtarları `Forced[0].mcx_preference_settings` altında tutar.
function unwrapProfile(value: unknown): unknown {
  const withoutProfileKeys = (input: unknown): unknown =>
    input === null || typeof input !== 'object' || Array.isArray(input)
      ? input
      : Object.fromEntries(
          Object.entries(input).filter(
            ([key]) => !key.startsWith('Payload') && !key.startsWith('_')
          )
        );
  const preferences = withoutProfileKeys(value) as Record<string, unknown> | unknown;
  if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
    const record = preferences as Record<string, unknown>;
    const forced = record.Forced;
    if (
      Object.keys(record).length === 1 &&
      Array.isArray(forced) &&
      forced.length === 1 &&
      forced[0] &&
      typeof forced[0] === 'object' &&
      'mcx_preference_settings' in forced[0]
    ) {
      return withoutProfileKeys((forced[0] as Record<string, unknown>).mcx_preference_settings);
    }
  }
  return preferences;
}

function convertWithPlutil(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PLUTIL,
      ['-convert', 'json', '-o', '-', path],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

function fromRaw(
  raw: unknown,
  source: string,
  knownProviderIds: readonly string[] | undefined
): ManagedPolicyLoadResult {
  const validated = validateManagedPolicy(raw, {
    source,
    ...(knownProviderIds ? { knownProviderIds } : {}),
  });
  if (!validated.success) {
    return {
      kind: 'error',
      error: validated.error,
      message: formatManagedPolicyError(validated.error),
    };
  }
  const fingerprint = managedPolicyFingerprint(validated.data);
  return {
    kind: 'loaded',
    loaded: {
      source,
      fingerprint,
      policy: validated.data,
      summary: summarizeManagedPolicy(validated.data, { source, fingerprint }),
    },
  };
}

function failure(source: string, reason: string): ManagedPolicyLoadResult {
  const error = { source, reason };
  return { kind: 'error', error, message: formatManagedPolicyError(error) };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Çalışan Orkestra sürecinin hangi politikayı yüklediğini `policy show` ile karşılaştırmak için
 * açılışta yazdığı küçük durum dosyası (sır içermez).
 */
export type LoadedManagedPolicyState = {
  pid: number;
  startedAt: string;
  /** Politika yoksa `null`. */
  policy: { source: string; organization: string; fingerprint: string } | null;
};

export function managedPolicyStatePath(homeDirectory: string): string {
  return join(homeDirectory, '.orkestra', 'managed-policy', 'loaded.json');
}

/** Politika varsa durumu yazar; yoksa önceki bir politikadan kalan kaydı siler. */
export async function recordLoadedManagedPolicy(
  homeDirectory: string,
  state: LoadedManagedPolicyState | null
): Promise<void> {
  const path = managedPolicyStatePath(homeDirectory);
  if (!state) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function readLoadedManagedPolicyState(
  homeDirectory: string
): Promise<LoadedManagedPolicyState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(managedPolicyStatePath(homeDirectory), 'utf8')
    ) as LoadedManagedPolicyState;
    return typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kurulu politikayı çalışan sürecin yüklediğiyle karşılaştırır (`policy show`). */
export function describeRunningHostPolicy(
  state: LoadedManagedPolicyState | null,
  installedFingerprint: string | null,
  isAlive: (pid: number) => boolean = isProcessAlive
): string {
  if (!state || !isAlive(state.pid) || !state.policy) {
    return installedFingerprint === null
      ? 'No running Orkestra host reports a loaded policy.'
      : 'No running Orkestra host reports a loaded policy. Start or restart Orkestra to apply the installed policy.';
  }
  const host = `The running Orkestra host (pid ${state.pid}, started ${state.startedAt})`;
  const loaded = state.policy.fingerprint;
  if (loaded === installedFingerprint) return `${host} loaded this policy.`;
  const what = `${state.policy.organization}'s policy from ${state.policy.source} (fingerprint ${state.policy.fingerprint})`;
  return `${host} loaded ${what}. Restart Orkestra to apply the installed policy.`;
}
