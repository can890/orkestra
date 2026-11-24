// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/BrowserImport.ts, SafariPermission.ts
//
// Kurulu bir tarayıcının çerezlerini Orkestra'nın uygulama içi tarayıcı profiline tek seferlik
// kopyalar. Electron oturumu ve anahtar zinciri enjekte edilen arayüzlerdir; testler sahtelerini
// kullanır. Çerez değerleri ve Safe Storage parolası hiçbir zaman loglanmaz ya da saklanmaz.
import type {
  BrowserImportFailureReason,
  BrowserImportInput,
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportSummary,
  BrowserImportUnavailableReason,
} from '@core/features/browser/api/browser-import';
import { ChromiumCookieReadError, readChromiumCookies } from './chromium-cookies';
import {
  ChromiumKeyError,
  resolveChromiumKeys,
  type SafeStorageSecretReader,
} from './chromium-keys';
import type { CookieReadResult, ImportedCookie } from './cookie-model';
import { readFirefoxCookies } from './firefox-cookies';
import {
  readSafariCookies,
  safariAccessDenied,
  safariAccessGranted,
  SafariCookieReadError,
} from './safari-cookies';
import {
  BROWSER_IMPORT_SOURCES,
  findBrowserImportSource,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  resolveCookieDatabase,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
  type RunningProbeOptions,
} from './sources';

/** Electron `Session.cookies` alt kümesi. */
export type CookieWriteTarget = {
  cookies: {
    set(details: {
      url: string;
      name: string;
      value: string;
      domain?: string;
      path?: string;
      secure?: boolean;
      httpOnly?: boolean;
      expirationDate?: number;
      sameSite?: ImportedCookie['sameSite'];
    }): Promise<void>;
    flushStore(): Promise<void>;
  };
};

export type BrowserImportServiceDeps = {
  context: BrowserImportPathContext;
  secrets: SafeStorageSecretReader;
  /** Hedef Orkestra profilinin oturumu; profil yoksa `undefined`. */
  getTargetSession(profileId: string): Promise<CookieWriteTarget | undefined>;
  running?: RunningProbeOptions;
  now?: () => number;
  /** Yalnızca meta veri loglar (kaynak kimliği, sayılar, neden); değer asla verilmez. */
  log?: (message: string, meta: Record<string, unknown>) => void;
};

export type BrowserImportService = {
  listSources(): Promise<BrowserImportSource[]>;
  importCookies(input: BrowserImportInput): Promise<BrowserImportResult>;
  checkFullDiskAccess(): Promise<boolean>;
};

const SKIPPED_DOMAIN_LIMIT = 20;

function cookieHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Ad ya da URL'si geçersiz çerezler Electron'a gönderilmeden atlanır. */
function isWritableCookie(cookie: ImportedCookie): boolean {
  if (!cookie.name || /[\s;=]/.test(cookie.name)) return false;
  try {
    const url = new URL(cookie.url);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Okunan çerezleri hedef oturuma yazar. Süresi dolmuş ya da geçersiz çerezler atlanır; reddedilen
 * tek bir çerez diğerlerini durdurmaz. Sonuçta yalnızca sayılar ve alan adları döner.
 */
export async function writeCookies(
  target: CookieWriteTarget,
  read: CookieReadResult,
  nowMs: number = Date.now()
): Promise<BrowserImportSummary> {
  const nowSeconds = Math.floor(nowMs / 1000);
  let imported = 0;
  let skippedExpired = 0;
  let skippedRejected = 0;
  const skippedDomains = new Set(read.skippedHosts);

  for (const cookie of read.cookies) {
    if (cookie.expirationDate !== undefined && cookie.expirationDate <= nowSeconds) {
      skippedExpired += 1;
      continue;
    }
    if (!isWritableCookie(cookie)) {
      skippedRejected += 1;
      skippedDomains.add(cookieHost(cookie.url));
      continue;
    }
    try {
      await target.cookies.set({
        url: cookie.url,
        name: cookie.name,
        value: cookie.value,
        // Electron verilen alanı genişletir; host-only çerezlerde alan verilmez.
        ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      });
      imported += 1;
    } catch {
      skippedRejected += 1;
      skippedDomains.add(cookieHost(cookie.url));
    }
  }

  // Yazımlar bellekte birikir; kalıcı bir içe aktarma bildirmeden önce diske boşaltılır.
  if (imported > 0) {
    try {
      await target.cookies.flushStore();
    } catch {
      // Electron çıkışta yine boşaltır; içe aktarma başarısız sayılmaz.
    }
  }

  const skippedUndecryptable = read.undecryptable;
  const skippedPartitioned = read.partitioned;
  return {
    imported,
    skipped: skippedExpired + skippedRejected + skippedUndecryptable + skippedPartitioned,
    skippedExpired,
    skippedPartitioned,
    skippedUndecryptable,
    skippedRejected,
    skippedDomains: [...skippedDomains].slice(0, SKIPPED_DOMAIN_LIMIT),
  };
}

export function createBrowserImportService(deps: BrowserImportServiceDeps): BrowserImportService {
  const { context } = deps;
  const tempOptions = context.tempRoot ? { tempRoot: context.tempRoot } : {};
  const log = deps.log ?? (() => {});

  async function unavailableReason(
    definition: BrowserImportSourceDefinition
  ): Promise<BrowserImportUnavailableReason | undefined> {
    if (!definition.platforms.includes(context.platform)) return 'unsupportedPlatform';
    if (!(await isSourceInstalled(definition, context))) return 'notInstalled';
    if (await isSourceRunning(definition, context, deps.running)) return 'browserRunning';
    // TCC stat'a izin verir; listelenen Safari dosyası yine de okunamayabilir.
    if (definition.engine === 'safari') {
      const jar = await resolveCookieDatabase(definition, context, '.');
      if (jar !== undefined && (await safariAccessDenied(jar))) return 'needsFullDiskAccess';
    }
    return undefined;
  }

  async function readSource(
    definition: BrowserImportSourceDefinition,
    databasePath: string
  ): Promise<CookieReadResult> {
    if (definition.engine === 'safari') return readSafariCookies(databasePath);
    if (definition.engine === 'firefox') return readFirefoxCookies(databasePath, tempOptions);
    // Anahtar zinciri istemi yalnızca burada, kullanıcı içe aktarmayı başlattığında görünür.
    const keys = await resolveChromiumKeys(
      {
        platform: context.platform,
        keychainService: definition.keychainService,
        keychainAccount: definition.keychainAccount,
        linuxSecretApplication: definition.linuxSecretApplication,
      },
      deps.secrets
    );
    return readChromiumCookies(databasePath, keys, tempOptions);
  }

  const fail = (reason: BrowserImportFailureReason): BrowserImportResult => ({
    success: false,
    reason,
  });

  return {
    async listSources() {
      const sources: BrowserImportSource[] = [];
      for (const definition of BROWSER_IMPORT_SOURCES) {
        // Bu platformda desteklenmeyen tarayıcılar hiç gösterilmez.
        if (!definition.platforms.includes(context.platform)) continue;
        const unavailable = await unavailableReason(definition);
        sources.push({
          id: definition.id,
          name: definition.name,
          engine: definition.engine,
          profiles:
            unavailable === undefined || unavailable === 'browserRunning'
              ? await listSourceProfiles(definition, context)
              : [],
          ...(unavailable === undefined ? {} : { unavailable }),
        });
      }
      return sources;
    },

    async importCookies(input) {
      const definition = findBrowserImportSource(input.sourceId);
      if (!definition) return fail('unknownSource');

      const blocked = await unavailableReason(definition);
      if (blocked !== undefined) return fail(blocked);

      // IPC'den gelen profil yolu listelenenlerden biri olmalı; tarayıcı veri dizini dışına
      // çıkılmasını önler.
      const profiles = await listSourceProfiles(definition, context, { counts: false });
      const profile = profiles.find((p) => p.directory === input.sourceProfileDirectory);
      if (!profile) return fail('unknownSourceProfile');

      const databasePath = await resolveCookieDatabase(definition, context, profile.directory);
      if (databasePath === undefined) return fail('readFailed');

      const target = await deps.getTargetSession(input.targetProfileId).catch(() => undefined);
      if (!target) return fail('unknownTargetProfile');

      let read: CookieReadResult;
      try {
        read = await readSource(definition, databasePath);
      } catch (error) {
        const reason: BrowserImportFailureReason =
          error instanceof ChromiumKeyError ||
          error instanceof ChromiumCookieReadError ||
          error instanceof SafariCookieReadError
            ? error.reason
            : 'readFailed';
        log('Browser cookie import failed', { sourceId: definition.id, reason });
        return fail(reason);
      }

      const summary = await writeCookies(target, read, deps.now?.() ?? Date.now());
      log('Browser cookies imported', {
        sourceId: definition.id,
        imported: summary.imported,
        skipped: summary.skipped,
      });
      return { success: true, summary };
    },

    async checkFullDiskAccess() {
      const safari = findBrowserImportSource('safari');
      if (!safari || context.platform !== 'darwin') return false;
      const defaultJar = await resolveCookieDatabase(safari, context, '.');
      if (defaultJar !== undefined) return safariAccessGranted(defaultJar);
      // İzin verildikten sonra adlandırılmış profiller yeniden keşfedilir.
      for (const profile of await listSourceProfiles(safari, context, { counts: false })) {
        const jar = await resolveCookieDatabase(safari, context, profile.directory);
        if (jar !== undefined && (await safariAccessGranted(jar))) return true;
      }
      return false;
    },
  };
}
