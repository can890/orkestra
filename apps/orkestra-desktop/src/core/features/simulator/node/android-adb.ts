/**
 * AndroidAdbService — Android Emulator & USB device host via `adb` + `emulator`.
 * Adapted from T3 Code (MIT License) LocalDeviceHost.ts & DeviceActions.ts.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { err, ok, type Result } from '@orkestra/shared';
import type { SimulatorDevice, SimulatorError, SimulatorKeyEvent } from '../api';

export const ANDROID_DEVICE_PREFIX = 'android:';
export const ANDROID_AVD_PREFIX = 'android-avd:';

const ANDROID_SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ANDROID_AVD_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const LONG_TIMEOUT_MS = 120_000;

const KEYCODE_MAP: Record<SimulatorKeyEvent, string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  enter: 'KEYCODE_ENTER',
  menu: 'KEYCODE_MENU',
  recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
};

const fail = (type: SimulatorError['type'], message: string) => err({ type, message });

function resolveSdkTool(subdir: string, binName: string): string | null {
  const candidates: string[] = [];
  const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (sdkRoot) candidates.push(join(sdkRoot, subdir, binName));
  candidates.push(join(homedir(), 'Library', 'Android', 'sdk', subdir, binName));
  candidates.push(join(homedir(), 'Android', 'Sdk', subdir, binName));
  candidates.push(`/opt/homebrew/bin/${binName}`, `/usr/local/bin/${binName}`);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function execBin(
  bin: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      { encoding: 'buffer', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
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
}

export function isAndroidDeviceId(udid: string): boolean {
  return udid.startsWith(ANDROID_DEVICE_PREFIX) || udid.startsWith(ANDROID_AVD_PREFIX);
}

function parseAndroidSerial(udid: string): Result<string, SimulatorError> {
  if (!udid.startsWith(ANDROID_DEVICE_PREFIX)) {
    return fail('invalid_input', 'Bu işlem için açık bir Android cihaz/emülatör seçilmelidir.');
  }
  const serial = udid.slice(ANDROID_DEVICE_PREFIX.length);
  if (!ANDROID_SERIAL_RE.test(serial)) {
    return fail('invalid_input', 'Geçersiz Android cihaz kimliği.');
  }
  return ok(serial);
}

/** `adb shell input text` için boşluk ve kabuk karakterlerini kaçırır. */
function escapeAdbInputText(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/\s+/g, '%s')
    .replace(/([&|;<>()$`"'*?[\]{}#!~])/g, '\\$1');
}

export class AndroidAdbService {
  private readonly adbBin: string | null;
  private readonly emulatorBin: string | null;

  constructor() {
    this.adbBin = resolveSdkTool('platform-tools', 'adb');
    this.emulatorBin = resolveSdkTool('emulator', 'emulator');
  }

  get available(): boolean {
    return this.adbBin !== null;
  }

  async listDevices(): Promise<SimulatorDevice[]> {
    if (!this.adbBin) return [];
    const devices: SimulatorDevice[] = [];
    const bootedAvdNames = new Set<string>();

    try {
      const { stdout } = await execBin(this.adbBin, ['devices', '-l'], DEFAULT_TIMEOUT_MS);
      const lines = stdout
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('List of devices'));

      for (const line of lines) {
        const parts = line.split(/\s+/);
        const serial = parts[0];
        const rawState = parts[1];
        if (!serial || !ANDROID_SERIAL_RE.test(serial)) continue;
        const modelField = parts.find((p) => p.startsWith('model:'));
        let displayName = modelField ? modelField.slice('model:'.length).replace(/_/g, ' ') : serial;
        let runtime = serial.startsWith('emulator-') ? 'Android Emülatör' : 'Android Cihaz';

        if (rawState === 'device') {
          try {
            const ver = await execBin(
              this.adbBin,
              ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'],
              3_000
            );
            const rel = ver.stdout.toString('utf8').trim();
            if (rel) runtime = `Android ${rel}`;
          } catch {
            // ignore prop fetch errors
          }
          if (serial.startsWith('emulator-')) {
            try {
              const avd = await execBin(this.adbBin, ['-s', serial, 'emu', 'avd', 'name'], 3_000);
              const avdName = avd.stdout.toString('utf8').split('\n')[0]?.trim();
              if (avdName && avdName !== 'OK') {
                bootedAvdNames.add(avdName);
                displayName = avdName.replace(/_/g, ' ');
              }
            } catch {
              // ignore
            }
          }
        }

        devices.push({
          udid: `${ANDROID_DEVICE_PREFIX}${serial}`,
          name: displayName,
          runtime,
          state: rawState === 'device' ? 'booted' : rawState === 'offline' ? 'booting' : 'unknown',
          platform: 'android',
        });
      }
    } catch {
      // adb server not ready yet — continue to list AVDs
    }

    if (this.emulatorBin) {
      try {
        const { stdout } = await execBin(this.emulatorBin, ['-list-avds'], DEFAULT_TIMEOUT_MS);
        const avds = stdout
          .toString('utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && ANDROID_AVD_RE.test(l));
        for (const avdName of avds) {
          if (bootedAvdNames.has(avdName)) continue;
          devices.push({
            udid: `${ANDROID_AVD_PREFIX}${avdName}`,
            name: avdName.replace(/_/g, ' '),
            runtime: 'Android AVD',
            state: 'shutdown',
            platform: 'android',
          });
        }
      } catch {
        // ignore AVD list errors
      }
    }

    return devices;
  }

  async bootDevice(udid: string): Promise<Result<void, SimulatorError>> {
    if (udid.startsWith(ANDROID_DEVICE_PREFIX)) return ok();
    if (!udid.startsWith(ANDROID_AVD_PREFIX)) {
      return fail('invalid_input', 'Geçersiz Android AVD kimliği.');
    }
    if (!this.emulatorBin) {
      return fail('unsupported', 'Android SDK emulator aracı bulunamadı.');
    }
    const avdName = udid.slice(ANDROID_AVD_PREFIX.length);
    if (!ANDROID_AVD_RE.test(avdName)) {
      return fail('invalid_input', 'Geçersiz Android AVD adı.');
    }
    try {
      const child = spawn(this.emulatorBin, ['-avd', avdName, '-no-snapshot-load'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async shutdownDevice(udid: string): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    try {
      await execBin(this.adbBin, ['-s', serial.data, 'emu', 'kill'], DEFAULT_TIMEOUT_MS);
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async screenshot(
    udid: string
  ): Promise<Result<{ data: string; mimeType: 'image/jpeg' | 'image/png' }, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    try {
      const { stdout } = await execBin(
        this.adbBin,
        ['-s', serial.data, 'exec-out', 'screencap', '-p'],
        SCREENSHOT_TIMEOUT_MS
      );
      if (!PNG_MAGIC.every((b, idx) => stdout[idx] === b)) {
        return fail('simctl_failed', 'Android ekran görüntüsü alınamadı; cihaz açık olmayabilir.');
      }
      return ok({ data: stdout.toString('base64'), mimeType: 'image/png' });
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async openUrl(udid: string, url: string): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    try {
      await execBin(
        this.adbBin,
        ['-s', serial.data, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url],
        DEFAULT_TIMEOUT_MS
      );
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async installApp(udid: string, apkPath: string): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    if (!isAbsolute(apkPath) || !normalize(apkPath).endsWith('.apk')) {
      return fail('invalid_input', 'Android kurulumu için mutlak bir .apk dosyası yolu verin.');
    }
    try {
      const resolved = await realpath(apkPath);
      const info = await stat(resolved);
      if (!info.isFile()) return fail('invalid_input', 'APK dosyası bulunamadı.');
      await execBin(this.adbBin, ['-s', serial.data, 'install', '-r', resolved], LONG_TIMEOUT_MS);
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async launchApp(udid: string, packageName: string): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    if (!PACKAGE_RE.test(packageName)) {
      return fail('invalid_input', 'Geçersiz Android paket adı (ör. com.orkestra.mobile).');
    }
    try {
      await execBin(
        this.adbBin,
        [
          '-s',
          serial.data,
          'shell',
          'monkey',
          '-p',
          packageName,
          '-c',
          'android.intent.category.LAUNCHER',
          '1',
        ],
        DEFAULT_TIMEOUT_MS
      );
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async setAppearance(
    udid: string,
    appearance: 'light' | 'dark'
  ): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    try {
      await execBin(
        this.adbBin,
        ['-s', serial.data, 'shell', 'cmd', 'uimode', 'night', appearance === 'dark' ? 'yes' : 'no'],
        DEFAULT_TIMEOUT_MS
      );
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async tap(udid: string, x: number, y: number): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    const rx = Math.max(0, Math.round(x));
    const ry = Math.max(0, Math.round(y));
    try {
      await execBin(
        this.adbBin,
        ['-s', serial.data, 'shell', 'input', 'tap', String(rx), String(ry)],
        DEFAULT_TIMEOUT_MS
      );
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 260
  ): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    const clampedDur = Math.max(50, Math.min(3000, Math.round(durationMs)));
    try {
      await execBin(
        this.adbBin,
        [
          '-s',
          serial.data,
          'shell',
          'input',
          'swipe',
          String(Math.max(0, Math.round(x1))),
          String(Math.max(0, Math.round(y1))),
          String(Math.max(0, Math.round(x2))),
          String(Math.max(0, Math.round(y2))),
          String(clampedDur),
        ],
        DEFAULT_TIMEOUT_MS
      );
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async inputText(udid: string, text: string): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    if (!text || text.length > 1000) {
      return fail('invalid_input', 'Girilecek metin boş veya çok uzun.');
    }
    try {
      await execBin(
        this.adbBin,
        ['-s', serial.data, 'shell', 'input', 'text', escapeAdbInputText(text)],
        DEFAULT_TIMEOUT_MS
      );
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }

  async keyEvent(udid: string, key: SimulatorKeyEvent): Promise<Result<void, SimulatorError>> {
    if (!this.adbBin) return fail('unsupported', 'adb bulunamadı.');
    const serial = parseAndroidSerial(udid);
    if (!serial.success) return serial;
    const keycode = KEYCODE_MAP[key];
    if (!keycode) return fail('invalid_input', `Bilinmeyen tuş olayı: ${String(key)}`);
    try {
      await execBin(
        this.adbBin,
        ['-s', serial.data, 'shell', 'input', 'keyevent', keycode],
        DEFAULT_TIMEOUT_MS
      );
      return ok();
    } catch (error) {
      return fail('simctl_failed', error instanceof Error ? error.message : String(error));
    }
  }
}
