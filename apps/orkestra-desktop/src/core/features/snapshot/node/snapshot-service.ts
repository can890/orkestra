import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '@orkestra/shared';
import { createEventStreamHost } from '@orkestra/wire/live';
import {
  snapshotContract,
  type SnapshotCaptureEvent,
  type SnapshotError,
  type SnapshotStatus,
} from '@core/features/snapshot/api/contract';
import type { SnapshotSettings } from '@core/primitives/app-settings/api';

const execFileAsync = promisify(execFile);

export type SnapshotServiceDeps = {
  getSettings: () => Promise<SnapshotSettings>;
  registerShortcut: (accelerator: string, callback: () => void) => boolean;
  unregisterShortcut: (accelerator: string) => void;
  isScreenPermissionGranted: () => boolean;
  focusMainWindow: () => void;
  logger?: {
    warn(message: string, context?: Record<string, unknown>): void;
  };
};

type WindowMeta = {
  appName?: string;
  windowTitle?: string;
  bounds?: { x: number; y: number; width: number; height: number };
};

async function readFrontmostWindowMeta(): Promise<WindowMeta> {
  if (process.platform !== 'darwin') return {};
  const script = [
    'tell application "System Events"',
    '  set frontApp to first application process whose frontmost is true',
    '  set appName to name of frontApp',
    '  set winTitle to ""',
    '  set winBounds to ""',
    '  try',
    '    set frontWin to front window of frontApp',
    '    set winTitle to name of frontWin',
    '    set pos to position of frontWin',
    '    set sz to size of frontWin',
    '    set winBounds to (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)',
    '  end try',
    '  return appName & "\\n" & winTitle & "\\n" & winBounds',
    'end tell',
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: 2_500,
      maxBuffer: 64 * 1024,
    });
    const [rawApp = '', rawTitle = '', rawBounds = ''] = stdout.split(/\r?\n/);
    const appName = rawApp.trim() || undefined;
    const windowTitle = rawTitle.trim() || undefined;
    const nums = rawBounds
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((n) => Number.isFinite(n));
    const bounds =
      nums.length === 4 && nums[2]! >= 20 && nums[3]! >= 20
        ? { x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]! }
        : undefined;
    return { appName, windowTitle, bounds };
  } catch {
    return {};
  }
}

export class SnapshotService {
  readonly eventHost = createEventStreamHost(snapshotContract.events);
  private registeredAccelerator: string | null = null;
  private capturing = false;

  constructor(private readonly deps: SnapshotServiceDeps) {}

  async refreshShortcut(): Promise<void> {
    if (this.registeredAccelerator) {
      this.deps.unregisterShortcut(this.registeredAccelerator);
      this.registeredAccelerator = null;
    }
    const settings = await this.deps.getSettings();
    const accelerator = settings.shortcut.trim();
    if (!settings.enabled || !accelerator) return;

    const okReg = this.deps.registerShortcut(accelerator, () => {
      void this.captureNow();
    });
    if (okReg) {
      this.registeredAccelerator = accelerator;
    } else {
      this.deps.logger?.warn('SnapShot global kısayolu kaydedilemedi', { accelerator });
    }
  }

  dispose(): void {
    if (this.registeredAccelerator) {
      this.deps.unregisterShortcut(this.registeredAccelerator);
      this.registeredAccelerator = null;
    }
  }

  async getStatus(): Promise<SnapshotStatus> {
    const settings = await this.deps.getSettings();
    return {
      supported: process.platform === 'darwin',
      enabled: settings.enabled,
      shortcut: settings.shortcut,
      registered: this.registeredAccelerator !== null,
      permissionGranted: this.deps.isScreenPermissionGranted(),
    };
  }

  async captureNow(): Promise<Result<SnapshotCaptureEvent, SnapshotError>> {
    if (process.platform !== 'darwin') {
      return err({
        type: 'unsupported',
        message: 'Global SnapShot yakalama şu anda yalnızca macOS üzerinde destekleniyor.',
      });
    }
    if (!this.deps.isScreenPermissionGranted()) {
      return err({
        type: 'permission_denied',
        message:
          "macOS Ekran Kaydı izni verilmedi. Sistem Ayarları → Gizlilik ve Güvenlik → Ekran Kaydı bölümünden Orkestra'ya izin verin.",
      });
    }
    if (this.capturing) {
      return err({ type: 'cancelled', message: 'Başka bir SnapShot yakalaması devam ediyor.' });
    }

    this.capturing = true;
    const tmpPath = join(tmpdir(), `orkestra-snapshot-${randomUUID()}.png`);
    try {
      const settings = await this.deps.getSettings();
      const meta = settings.includeWindowMetadata ? await readFrontmostWindowMeta() : {};

      const args = ['-x', '-t', 'png'];
      let timeoutMs = 6_000;
      if (settings.captureMode === 'interactive') {
        args.push('-i');
        timeoutMs = 20_000;
      } else if (meta.bounds) {
        args.push(
          '-o',
          '-R',
          `${meta.bounds.x},${meta.bounds.y},${meta.bounds.width},${meta.bounds.height}`
        );
      }
      args.push(tmpPath);

      try {
        await execFileAsync('screencapture', args, { timeout: timeoutMs });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return err({
          type: 'capture_failed',
          message: `Ekran görüntüsü alınamadı: ${msg}`,
        });
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(tmpPath);
      } catch {
        return err({
          type: 'cancelled',
          message: 'Ekran yakalama iptal edildi.',
        });
      }

      if (bytes.byteLength === 0) {
        return err({ type: 'cancelled', message: 'Ekran yakalama boş döndü.' });
      }

      const event: SnapshotCaptureEvent = {
        id: randomUUID(),
        createdAt: Date.now(),
        ...(meta.appName ? { appName: meta.appName } : {}),
        ...(meta.windowTitle ? { windowTitle: meta.windowTitle } : {}),
        mimeType: 'image/png',
        base64: bytes.toString('base64'),
      };

      this.deps.focusMainWindow();
      this.eventHost.emit(undefined, event);
      return ok(event);
    } finally {
      this.capturing = false;
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}
