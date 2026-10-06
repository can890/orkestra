import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ORKESTRA_RELEASES_URL } from '@core/primitives/urls/api/urls';
import { buildExternalToolEnv } from '@main/lib/childProcessEnv';
import { assertChecksumMatches, expectedChecksum, sha256File } from './checksums';
import {
  isAdHocRequirement,
  readBundleIdentifier,
  readDesignatedRequirement,
  UpdateRefusedError,
  verifyCandidateSignature,
  type ExecFile,
} from './code-signature';
import { downloadFile, type DownloadProgress } from './download';
import { checkInstallLocation, type InstallSupport } from './install-location';
import { buildInstallScript } from './install-script';
import { compareVersions } from './utils';

export type ReleaseAsset = { name: string; url: string; size?: number };
export type InstallableRelease = { version: string; assets: readonly ReleaseAsset[] };
/** İndirilmiş, doğrulanmış ve geçici bir dizine açılmış yeni sürüm. */
export type PreparedUpdate = { version: string; appPath: string; workDir: string };

/** Uygulama içi kurulumun güncelleme hizmetinin gördüğü yüzü; testlerde sahtesiyle değiştirilir. */
export interface InAppInstaller {
  checkSupport(): Promise<InstallSupport>;
  prepare(
    release: InstallableRelease,
    onProgress: (progress: DownloadProgress) => void
  ): Promise<PreparedUpdate>;
  isPrepared(prepared: PreparedUpdate): Promise<boolean>;
  /** Kurulum yardımcısını bağımsız süreç olarak başlatır; uygulamayı kapatmak çağıranın işidir. */
  launchInstaller(prepared: PreparedUpdate): Promise<void>;
  /** Önceki kurulum denemesi başarısız olduysa nedenini döndürür ve kaydı siler. */
  takeInstallFailure(): Promise<string | null>;
  /** Çalışan sürümle aynı ya da daha eski sürümlerin indirme önbelleğini siler. */
  cleanup(currentVersion: string): Promise<void>;
}

export const CHECKSUMS_ASSET = 'SHA256SUMS';
const RELEASE_DOWNLOAD_PREFIX = `${ORKESTRA_RELEASES_URL}/download/`;
const CHECKSUMS_TIMEOUT_MS = 15_000;
const DITTO = '/usr/bin/ditto';

export function zipAssetName(arch: string): string {
  return `orkestra-${arch}.zip`;
}

/** Yalnızca bu deponun sürüm indirmeleri kabul edilir; GitHub bunları kendi CDN'ine yönlendirir. */
export function isTrustedAssetUrl(url: string): boolean {
  return url.startsWith(RELEASE_DOWNLOAD_PREFIX) && !url.includes('..');
}

export type MacInstallerDeps = {
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  isPackaged(): boolean;
  exePath(): string;
  userDataDir(): string;
  tempDir(): string;
  userAgent(): string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  exec: ExecFile;
  spawnDetached(file: string, args: readonly string[]): Promise<void>;
};

type SupportedContext = { bundlePath: string; requirement: string; bundleId: string };
type SupportResult = { result: InstallSupport; context?: SupportedContext };

/**
 * macOS'ta çalışan .app paketini yerinde güncelleyen kurucu: sürümün ZIP paketini indirir,
 * SHA256SUMS ve kod imzasıyla doğrular, geçici bir dizine açar ve kurulum yardımcısını başlatır.
 */
export class MacInAppInstaller implements InAppInstaller {
  private support: Promise<SupportResult> | null = null;

  constructor(private readonly deps: MacInstallerDeps) {}

  private get updatesDir(): string {
    return join(this.deps.userDataDir(), 'updates');
  }

  private get resultFile(): string {
    return join(this.updatesDir, 'install-result.txt');
  }

  async checkSupport(): Promise<InstallSupport> {
    return (await this.resolveSupport()).result;
  }

  private resolveSupport(): Promise<SupportResult> {
    this.support ??= this.detectSupport();
    return this.support;
  }

  private async detectSupport(): Promise<SupportResult> {
    const location = await checkInstallLocation({
      platform: this.deps.platform,
      arch: this.deps.arch,
      isPackaged: this.deps.isPackaged(),
      exePath: this.deps.exePath(),
      isWritable: async (path) => {
        try {
          await access(path, constants.W_OK);
          return true;
        } catch {
          return false;
        }
      },
    });
    if (!location.supported) return { result: location };
    try {
      const requirement = await readDesignatedRequirement(this.deps.exec, location.bundlePath);
      if (isAdHocRequirement(requirement)) {
        return {
          result: {
            supported: false,
            reason:
              'Bu Orkestra kurulumu kalıcı imza kimliği taşımıyor (ad-hoc imza); güncellemeler sürüm sayfasından elle kurulur.',
          },
        };
      }
      const bundleId = await readBundleIdentifier(this.deps.exec, location.bundlePath);
      return {
        result: location,
        context: { bundlePath: location.bundlePath, requirement, bundleId },
      };
    } catch (error) {
      return {
        result: {
          supported: false,
          reason: `Çalışan uygulamanın imzası okunamadı: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private async requireContext(): Promise<SupportedContext> {
    const { result, context } = await this.resolveSupport();
    if (!result.supported || !context) {
      throw new UpdateRefusedError(
        result.supported ? 'Uygulama içi kurulum kullanılamıyor.' : result.reason
      );
    }
    return context;
  }

  async prepare(
    release: InstallableRelease,
    onProgress: (progress: DownloadProgress) => void
  ): Promise<PreparedUpdate> {
    const context = await this.requireContext();
    const assetName = zipAssetName(this.deps.arch);
    const zipAsset = release.assets.find((asset) => asset.name === assetName);
    if (!zipAsset) {
      throw new UpdateRefusedError(`${release.version} sürümünde ${assetName} paketi yok.`);
    }
    const sumsAsset = release.assets.find((asset) => asset.name === CHECKSUMS_ASSET);
    if (!sumsAsset) {
      throw new UpdateRefusedError(
        `${release.version} sürümünde SHA256SUMS dosyası yok; indirilen paket doğrulanamaz.`
      );
    }
    for (const asset of [zipAsset, sumsAsset]) {
      if (!isTrustedAssetUrl(asset.url)) {
        throw new UpdateRefusedError(`Beklenmeyen indirme adresi reddedildi: ${asset.url}`);
      }
    }

    const expected = expectedChecksum(await this.fetchText(sumsAsset.url), assetName);
    const cacheDir = join(this.updatesDir, release.version);
    await mkdir(cacheDir, { recursive: true });
    const zipPath = join(cacheDir, assetName);
    await downloadFile({
      url: zipAsset.url,
      destination: zipPath,
      expectedSize: zipAsset.size,
      userAgent: this.deps.userAgent(),
      fetch: this.deps.fetch,
      onProgress,
    });
    const actual = await sha256File(zipPath);
    try {
      assertChecksumMatches(actual, expected, assetName);
    } catch (error) {
      await rm(zipPath, { force: true });
      throw error;
    }

    const workDir = await mkdtemp(join(this.deps.tempDir(), 'orkestra-update-'));
    try {
      const extractDir = join(workDir, 'extracted');
      await this.deps.exec(DITTO, ['-x', '-k', zipPath, extractDir], { timeoutMs: 300_000 });
      const appPath = await findSingleApp(extractDir);
      await verifyCandidateSignature(this.deps.exec, {
        candidateApp: appPath,
        runningRequirement: context.requirement,
        runningBundleId: context.bundleId,
        expectedVersion: release.version,
      });
      return { version: release.version, appPath, workDir };
    } catch (error) {
      await rm(workDir, { recursive: true, force: true });
      throw error;
    }
  }

  async isPrepared(prepared: PreparedUpdate): Promise<boolean> {
    try {
      return (await stat(join(prepared.appPath, 'Contents', 'Info.plist'))).isFile();
    } catch {
      return false;
    }
  }

  async launchInstaller(prepared: PreparedUpdate): Promise<void> {
    const context = await this.requireContext();
    await mkdir(this.updatesDir, { recursive: true });
    await rm(this.resultFile, { force: true });
    const script = buildInstallScript({
      parentPid: this.deps.pid,
      targetApp: context.bundlePath,
      sourceApp: prepared.appPath,
      requirement: context.requirement,
      logFile: join(this.updatesDir, 'install.log'),
      resultFile: this.resultFile,
      cleanupDir: prepared.workDir,
      stamp: String(Date.now()),
    });
    const scriptPath = join(prepared.workDir, 'install.sh');
    await writeFile(scriptPath, script, { mode: 0o700 });
    await this.deps.spawnDetached('/bin/sh', [scriptPath]);
  }

  async takeInstallFailure(): Promise<string | null> {
    try {
      const text = (await readFile(this.resultFile, 'utf8')).trim();
      await rm(this.resultFile, { force: true });
      return text || null;
    } catch {
      return null;
    }
  }

  async cleanup(currentVersion: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.updatesDir);
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const comparison = compareVersions(entry, currentVersion);
        if (comparison === null || comparison > 0) return;
        await rm(join(this.updatesDir, entry), { recursive: true, force: true });
      })
    );
  }

  private async fetchText(url: string): Promise<string> {
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        headers: { 'User-Agent': this.deps.userAgent() },
        signal: AbortSignal.timeout(CHECKSUMS_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`SHA256SUMS indirilemedi: ${reason}`);
    }
    if (!response.ok) throw new Error(`SHA256SUMS indirilemedi (HTTP ${response.status}).`);
    return response.text();
  }
}

async function findSingleApp(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (apps.length !== 1) {
    throw new Error(`Güncelleme paketinde tek bir uygulama bekleniyordu; ${apps.length} bulundu.`);
  }
  return join(dir, apps[0]!.name);
}

/** Araçları kabuk olmadan çalıştırır; çıktıyı (stdout + stderr) döndürür. */
export const execFileCollect: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: options?.timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: buildExternalToolEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
