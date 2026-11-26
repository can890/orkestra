import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { err, ok, type Result } from '@orkestra/shared';
import {
  SIMULATOR_UDID_PATTERN,
  type SimulatorDevice,
  type SimulatorDeviceState,
  type SimulatorError,
  type SimulatorKeyEvent,
} from '../api';
import { AndroidAdbService, isAndroidDeviceId } from './android-adb';

/** `xcrun` çağrısının sonucu; çıktı ikili (ekran görüntüsü) olabilir. */
export type SimctlProcessResult = { stdout: Buffer; stderr: string };

/**
 * `xcrun` altında bir komutu argv dizisiyle çalıştırır. Hiçbir shell yoktur: argümanlar komut
 * metnine gömülmez. Testlerde sahte bir çalıştırıcı enjekte edilir.
 */
export type SimctlRunner = (
  argv: readonly string[],
  options: { timeoutMs: number }
) => Promise<SimctlProcessResult>;

export type SimulatorServiceDeps = {
  run?: SimctlRunner;
  platform?: NodeJS.Platform;
  /** `.app` paketinin gerçek yolunu ve türünü denetler; testte sahtelenir. */
  inspectApp?: (
    path: string
  ) => Promise<{ realPath: string; isDirectory: boolean; hasInfoPlist: boolean }>;
  /** İsteğe bağlı Android ADB servisi; testlerde `null` geçilerek kapatılabilir. */
  android?: AndroidAdbService | null;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;
/** Cihazı başlatma ve uygulama kurma uzun sürebilir. */
const LONG_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_PATH_LENGTH = 1024;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const BLOCKED_URL_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:']);
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** Alt sürece yalnızca gereken ortam değişkenleri verilir. */
function simctlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'DEVELOPER_DIR', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export const runXcrun: SimctlRunner = (argv, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      'xcrun',
      [...argv],
      { encoding: 'buffer', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: simctlEnv() },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString('utf8').trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolve({ stdout, stderr: stderr.toString('utf8') });
      }
    );
  });

async function inspectAppOnDisk(
  path: string
): Promise<{ realPath: string; isDirectory: boolean; hasInfoPlist: boolean }> {
  const realPath = await realpath(path);
  const info = await stat(realPath);
  let hasInfoPlist = false;
  if (info.isDirectory()) {
    hasInfoPlist = await stat(join(realPath, 'Info.plist'))
      .then((plist) => plist.isFile())
      .catch(() => false);
  }
  return { realPath, isDirectory: info.isDirectory(), hasInfoPlist };
}

const fail = (type: SimulatorError['type'], message: string) => err({ type, message });

export function validateUdid(value: string): Result<string, SimulatorError> {
  return SIMULATOR_UDID_PATTERN.test(value)
    ? ok(value.toUpperCase())
    : fail('invalid_input', 'Geçersiz cihaz kimliği (UDID).');
}

export function validateBundleId(value: string): Result<string, SimulatorError> {
  return BUNDLE_ID_PATTERN.test(value)
    ? ok(value)
    : fail('invalid_input', 'Geçersiz uygulama paket kimliği (bundle id).');
}

export function validateOpenUrl(value: string): Result<string, SimulatorError> {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return fail('invalid_input', 'URL boş ya da çok uzun.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(value)) {
    return fail('invalid_input', 'URL boşluk ya da denetim karakteri içeremez.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('invalid_input', 'URL ayrıştırılamadı; şema gerekli (ör. https://).');
  }
  if (BLOCKED_URL_SCHEMES.has(parsed.protocol)) {
    return fail('invalid_input', `"${parsed.protocol}" şeması izinli değil.`);
  }
  return ok(value);
}

/** Mutlak, normalleştirilmiş ve `.app` ile biten bir yol; varlık denetimi ayrıca yapılır. */
export function validateAppPathShape(value: string): Result<string, SimulatorError> {
  if (value.length === 0 || value.length > MAX_PATH_LENGTH || value.includes('\0')) {
    return fail('invalid_input', 'Uygulama yolu geçersiz.');
  }
  if (!isAbsolute(value)) return fail('invalid_input', 'Uygulama yolu mutlak olmalı.');
  const normalized = normalize(value).replace(/\/+$/, '');
  if (normalized !== value.replace(/\/+$/, '')) {
    return fail('invalid_input', 'Uygulama yolu ".." ya da yinelenen ayraç içeremez.');
  }
  if (!normalized.endsWith('.app')) {
    return fail('invalid_input', 'Yol bir .app paketi olmalı.');
  }
  return ok(normalized);
}

const STATE_MAP: Record<string, SimulatorDeviceState> = {
  Booted: 'booted',
  Shutdown: 'shutdown',
  Booting: 'booting',
  'Shutting Down': 'shutting-down',
};

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-2` → `iOS 18.2`; iOS olmayanlar için null. */
export function runtimeLabel(runtimeId: string): string | null {
  const match = /\.SimRuntime\.iOS-(\d+)(?:-(\d+))?(?:-(\d+))?/.exec(runtimeId);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].filter((part): part is string => part !== undefined);
  return `iOS ${parts.join('.')}`;
}

/** `simctl list devices --json` çıktısından kullanılabilir iOS cihazlarını çıkarır. */
export function parseDeviceList(json: string): Result<SimulatorDevice[], SimulatorError> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return fail('simctl_failed', 'simctl çıktısı okunamadı.');
  }
  const groups = (data as { devices?: unknown } | null)?.devices;
  if (typeof groups !== 'object' || groups === null) {
    return fail('simctl_failed', 'simctl cihaz listesi beklenen biçimde değil.');
  }
  const devices: SimulatorDevice[] = [];
  for (const [runtimeId, entries] of Object.entries(groups)) {
    const runtime = runtimeLabel(runtimeId);
    if (!runtime || !Array.isArray(entries)) continue;
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (entry.isAvailable !== true) continue;
      const { udid, name, state } = entry;
      if (typeof udid !== 'string' || !SIMULATOR_UDID_PATTERN.test(udid)) continue;
      if (typeof name !== 'string') continue;
      devices.push({
        udid: udid.toUpperCase(),
        name,
        runtime,
        state: (typeof state === 'string' ? STATE_MAP[state] : undefined) ?? 'unknown',
      });
    }
  }
  devices.sort(
    (a, b) =>
      Number(b.state === 'booted') - Number(a.state === 'booted') ||
      b.runtime.localeCompare(a.runtime, 'en', { numeric: true }) ||
      a.name.localeCompare(b.name)
  );
  return ok(devices);
}

/**
 * `xcrun simctl` üzerindeki tüm işlemler. Her komut argv dizisidir; UDID, paket kimliği, URL ve
 * uygulama yolu çalıştırmadan önce katı biçimde doğrulanır. Yalnızca macOS'ta etkindir.
 */
export class SimulatorService {
  private readonly run: SimctlRunner;
  private readonly platform: NodeJS.Platform;
  private readonly inspectApp: NonNullable<SimulatorServiceDeps['inspectApp']>;
  private readonly android: AndroidAdbService | null;

  constructor(deps: SimulatorServiceDeps = {}) {
    this.run = deps.run ?? runXcrun;
    this.platform = deps.platform ?? process.platform;
    this.inspectApp = deps.inspectApp ?? inspectAppOnDisk;
    // Testlerde başka bir platform simüle edilirken yerel makinenin Android SDK'sını tarama.
    this.android =
      deps.android !== undefined
        ? deps.android
        : deps.platform !== undefined && deps.platform !== process.platform
          ? null
          : new AndroidAdbService();
  }

  get supported(): boolean {
    return this.platform === 'darwin' || Boolean(this.android?.available);
  }

  async listDevices(): Promise<Result<SimulatorDevice[], SimulatorError>> {
    const androidDevices = this.android?.available ? await this.android.listDevices() : [];
    if (this.platform !== 'darwin') {
      if (androidDevices.length > 0) return ok(androidDevices);
      return fail('unsupported', 'iOS Simülatör yalnızca macOS üzerinde kullanılabilir.');
    }
    const result = await this.simctl(['list', 'devices', '--json'], DEFAULT_TIMEOUT_MS);
    if (!result.success) {
      if (androidDevices.length > 0) return ok(androidDevices);
      return result;
    }
    const ios = parseDeviceList(result.data.stdout.toString('utf8'));
    if (!ios.success) {
      if (androidDevices.length > 0) return ok(androidDevices);
      return ios;
    }
    const merged = [
      ...androidDevices,
      ...ios.data.map((d) => ({ ...d, platform: 'ios' as const })),
    ];
    merged.sort(
      (a, b) =>
        Number(b.state === 'booted') - Number(a.state === 'booted') ||
        a.name.localeCompare(b.name)
    );
    return ok(merged);
  }

  async bootDevice(udid: string): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid)) {
      return this.android
        ? this.android.bootDevice(udid)
        : fail('unsupported', 'Android SDK kullanılamıyor.');
    }
    const id = validateUdid(udid);
    if (!id.success) return id;
    const result = await this.simctl(['boot', id.data], LONG_TIMEOUT_MS);
    // Zaten açık cihaz hata sayılmaz.
    if (!result.success && /current state: Booted/i.test(result.error.message)) return ok();
    return result.success ? ok() : result;
  }

  async shutdownDevice(udid: string): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid)) {
      return this.android
        ? this.android.shutdownDevice(udid)
        : fail('unsupported', 'Android SDK kullanılamıyor.');
    }
    const id = validateUdid(udid);
    if (!id.success) return id;
    const result = await this.simctl(['shutdown', id.data], LONG_TIMEOUT_MS);
    if (!result.success && /current state: Shutdown/i.test(result.error.message)) return ok();
    return result.success ? ok() : result;
  }

  async screenshot(
    udid: string
  ): Promise<Result<{ data: string; mimeType: 'image/jpeg' | 'image/png' }, SimulatorError>> {
    if (isAndroidDeviceId(udid)) {
      return this.android
        ? this.android.screenshot(udid)
        : fail('unsupported', 'Android SDK kullanılamıyor.');
    }
    const id = validateUdid(udid);
    if (!id.success) return id;
    const result = await this.simctl(
      ['io', id.data, 'screenshot', '--type=jpeg', '-'],
      SCREENSHOT_TIMEOUT_MS
    );
    if (!result.success) return result;
    const bytes = result.data.stdout;
    if (!JPEG_MAGIC.every((value, index) => bytes[index] === value)) {
      return fail('simctl_failed', 'Ekran görüntüsü alınamadı; cihaz açık olmayabilir.');
    }
    return ok({ data: bytes.toString('base64'), mimeType: 'image/jpeg' });
  }

  async openUrl(udid: string, url: string): Promise<Result<void, SimulatorError>> {
    const target = validateOpenUrl(url);
    if (!target.success) return target;
    if (isAndroidDeviceId(udid)) {
      return this.android
        ? this.android.openUrl(udid, target.data)
        : fail('unsupported', 'Android SDK kullanılamıyor.');
    }
    const id = validateUdid(udid);
    if (!id.success) return id;
    const result = await this.simctl(['openurl', id.data, target.data], DEFAULT_TIMEOUT_MS);
    return result.success ? ok() : result;
  }

  async installApp(udid: string, appPath: string): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid)) {
      return this.android
        ? this.android.installApp(udid, appPath)
        : fail('unsupported', 'Android SDK kullanılamıyor.');
    }
    const id = validateUdid(udid);
    if (!id.success) return id;
    const shape = validateAppPathShape(appPath);
    if (!shape.success) return shape;
    let inspected: Awaited<ReturnType<NonNullable<SimulatorServiceDeps['inspectApp']>>>;
    try {
      inspected = await this.inspectApp(shape.data);
    } catch {
      return fail('invalid_input', 'Uygulama paketi bulunamadı.');
    }
    if (!inspected.isDirectory || !inspected.hasInfoPlist) {
      return fail('invalid_input', 'Yol geçerli bir .app paketi değil (Info.plist yok).');
    }
    // Sembolik bağ üzerinden `.app` olmayan bir hedefe çıkılmasını engelle.
    if (!inspected.realPath.endsWith('.app')) {
      return fail('invalid_input', 'Yol bir .app paketine çözümlenmiyor.');
    }
    const result = await this.simctl(['install', id.data, inspected.realPath], LONG_TIMEOUT_MS);
    return result.success ? ok() : result;
  }

  async launchApp(udid: string, bundleId: string): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid)) {
      return this.android
        ? this.android.launchApp(udid, bundleId)
        : fail('unsupported', 'Android SDK kullanılamıyor.');
    }
    const id = validateUdid(udid);
    if (!id.success) return id;
    const bundle = validateBundleId(bundleId);
    if (!bundle.success) return bundle;
    const result = await this.simctl(['launch', id.data, bundle.data], DEFAULT_TIMEOUT_MS);
    return result.success ? ok() : result;
  }

  async setAppearance(
    udid: string,
    appearance: 'light' | 'dark'
  ): Promise<Result<void, SimulatorError>> {
    if (appearance !== 'light' && appearance !== 'dark') {
      return fail('invalid_input', 'Görünüm "light" ya da "dark" olmalı.');
    }
    if (isAndroidDeviceId(udid)) {
      return this.android
        ? this.android.setAppearance(udid, appearance)
        : fail('unsupported', 'Android SDK kullanılamıyor.');
    }
    const id = validateUdid(udid);
    if (!id.success) return id;
    const result = await this.simctl(['ui', id.data, 'appearance', appearance], DEFAULT_TIMEOUT_MS);
    return result.success ? ok() : result;
  }

  async tap(udid: string, x: number, y: number): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid) && this.android) return this.android.tap(udid, x, y);
    return fail('unsupported', 'Dokunma girişi şimdilik yalnızca Android emülatör/cihazlarda desteklenir.');
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number
  ): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid) && this.android) {
      return this.android.swipe(udid, x1, y1, x2, y2, durationMs);
    }
    return fail('unsupported', 'Kaydırma girişi şimdilik yalnızca Android emülatör/cihazlarda desteklenir.');
  }

  async inputText(udid: string, text: string): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid) && this.android) return this.android.inputText(udid, text);
    return fail('unsupported', 'Metin girişi şimdilik yalnızca Android emülatör/cihazlarda desteklenir.');
  }

  async keyEvent(udid: string, key: SimulatorKeyEvent): Promise<Result<void, SimulatorError>> {
    if (isAndroidDeviceId(udid) && this.android) return this.android.keyEvent(udid, key);
    return fail('unsupported', 'Tuş olayı şimdilik yalnızca Android emülatör/cihazlarda desteklenir.');
  }

  private async simctl(
    args: readonly string[],
    timeoutMs: number
  ): Promise<Result<SimctlProcessResult, SimulatorError>> {
    if (!this.supported) {
      return fail('unsupported', 'iOS Simülatör yalnızca macOS üzerinde kullanılabilir.');
    }
    try {
      return ok(await this.run(['simctl', ...args], { timeoutMs }));
    } catch (error) {
      return fail('simctl_failed', cleanMessage(error));
    }
  }
}

/** simctl hata metnini ilk anlamlı satıra indirger (yol ve uzun yığınları taşımaz). */
function cleanMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line =
    raw
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? 'simctl komutu başarısız oldu.';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
