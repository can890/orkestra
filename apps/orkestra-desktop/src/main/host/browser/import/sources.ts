// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/Sources.ts
//
// Kurulu tarayıcıların, profillerinin ve çerez veritabanlarının keşfi. Tüm yollar enjekte edilen
// bir bağlamdan (ev dizini, platform, ortam) türetilir; testler sahte bir ev dizini ağacı kullanır.
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import nodePath, { type PlatformPath } from 'node:path';
import type {
  BrowserImportEngine,
  BrowserImportSourceId,
  BrowserImportSourceProfile,
} from '@core/features/browser/api/browser-import';
import { hasTable, withCookieDatabaseSnapshot } from './cookie-database';

export type BrowserImportPathContext = {
  path: PlatformPath;
  platform: NodeJS.Platform;
  home: string;
  linuxConfigHome: string;
  linuxChromeConfigHome: string;
  appData: string | undefined;
  localAppData: string | undefined;
  /** Kopya veritabanlarının açılacağı geçici kök (testlerde izole dizin). */
  tempRoot?: string;
};

export type BrowserImportSourceDefinition = {
  id: BrowserImportSourceId;
  name: string;
  engine: BrowserImportEngine;
  platforms: readonly NodeJS.Platform[];
  userDataDirectory: (context: BrowserImportPathContext) => string | undefined;
  alternateLinuxRoots?: (context: BrowserImportPathContext) => readonly string[];
  keychainService?: string;
  keychainAccount?: string;
  linuxSecretApplication?: string;
};

const macApplicationSupport = (context: BrowserImportPathContext, ...segments: string[]) =>
  context.path.join(context.home, 'Library', 'Application Support', ...segments);

function chromiumSource(input: {
  id: BrowserImportSourceId;
  name: string;
  keychainService: string;
  keychainAccount: string;
  macSegments: string[];
  linuxSegments?: string[];
  linuxSecretApplication?: string;
}): BrowserImportSourceDefinition {
  return {
    id: input.id,
    name: input.name,
    engine: 'chromium',
    // Windows'ta Chromium 127+ uygulamaya bağlı şifreleme kullandığından desteklenmez.
    platforms: ['darwin', ...(input.linuxSegments ? (['linux'] as const) : [])],
    keychainService: input.keychainService,
    keychainAccount: input.keychainAccount,
    ...(input.linuxSecretApplication === undefined
      ? {}
      : { linuxSecretApplication: input.linuxSecretApplication }),
    userDataDirectory: (context) => {
      if (context.platform === 'darwin')
        return macApplicationSupport(context, ...input.macSegments);
      if (context.platform === 'linux' && input.linuxSegments) {
        return context.path.join(
          input.id === 'chrome' ? context.linuxChromeConfigHome : context.linuxConfigHome,
          ...input.linuxSegments
        );
      }
      return undefined;
    },
  };
}

export const BROWSER_IMPORT_SOURCES: readonly BrowserImportSourceDefinition[] = [
  chromiumSource({
    id: 'chrome',
    name: 'Google Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    macSegments: ['Google', 'Chrome'],
    linuxSegments: ['google-chrome'],
    linuxSecretApplication: 'chrome',
  }),
  chromiumSource({
    id: 'edge',
    name: 'Microsoft Edge',
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
    macSegments: ['Microsoft Edge'],
    linuxSegments: ['microsoft-edge'],
    linuxSecretApplication: 'msedge',
  }),
  chromiumSource({
    id: 'brave',
    name: 'Brave',
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
    macSegments: ['BraveSoftware', 'Brave-Browser'],
    linuxSegments: ['BraveSoftware', 'Brave-Browser'],
    linuxSecretApplication: 'brave',
  }),
  chromiumSource({
    id: 'arc',
    name: 'Arc',
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc',
    macSegments: ['Arc', 'User Data'],
  }),
  chromiumSource({
    id: 'vivaldi',
    name: 'Vivaldi',
    keychainService: 'Vivaldi Safe Storage',
    keychainAccount: 'Vivaldi',
    macSegments: ['Vivaldi'],
    linuxSegments: ['vivaldi'],
    // Vivaldi Linux anahtarını Chrome'un uygulama adıyla saklar.
    linuxSecretApplication: 'chrome',
  }),
  chromiumSource({
    id: 'opera',
    name: 'Opera',
    keychainService: 'Opera Safe Storage',
    keychainAccount: 'Opera',
    macSegments: ['com.operasoftware.Opera'],
    linuxSegments: ['opera'],
    linuxSecretApplication: 'opera',
  }),
  chromiumSource({
    id: 'helium',
    name: 'Helium',
    keychainService: 'Helium Storage Key',
    keychainAccount: 'Helium',
    macSegments: ['net.imput.helium'],
    linuxSegments: ['net.imput.helium'],
    linuxSecretApplication: 'chromium',
  }),
  chromiumSource({
    id: 'chromium',
    name: 'Chromium',
    keychainService: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
    macSegments: ['Chromium'],
    linuxSegments: ['chromium'],
    linuxSecretApplication: 'chromium',
  }),
  {
    id: 'safari',
    name: 'Safari',
    engine: 'safari',
    platforms: ['darwin'],
    userDataDirectory: (context) =>
      context.platform === 'darwin'
        ? context.path.join(
            context.home,
            'Library',
            'Containers',
            'com.apple.Safari',
            'Data',
            'Library',
            'Cookies'
          )
        : undefined,
  },
  {
    id: 'firefox',
    name: 'Firefox',
    engine: 'firefox',
    platforms: ['darwin', 'win32', 'linux'],
    userDataDirectory: (context) => {
      if (context.platform === 'darwin') return macApplicationSupport(context, 'Firefox');
      if (context.platform === 'win32') {
        return context.appData
          ? context.path.join(context.appData, 'Mozilla', 'Firefox')
          : undefined;
      }
      return context.path.join(context.home, '.mozilla', 'firefox');
    },
    alternateLinuxRoots: (context) => [
      context.path.join(context.home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    ],
  },
  {
    id: 'zen',
    name: 'Zen',
    engine: 'firefox',
    platforms: ['darwin', 'win32', 'linux'],
    userDataDirectory: (context) => {
      if (context.platform === 'darwin') return macApplicationSupport(context, 'zen');
      if (context.platform === 'win32') {
        return context.appData ? context.path.join(context.appData, 'zen') : undefined;
      }
      return context.path.join(context.linuxConfigHome, 'zen');
    },
    alternateLinuxRoots: (context) => [
      context.path.join(context.home, '.zen'),
      context.path.join(context.home, '.var', 'app', 'app.zen_browser.zen', 'zen'),
    ],
  },
];

export function findBrowserImportSource(id: string): BrowserImportSourceDefinition | undefined {
  return BROWSER_IMPORT_SOURCES.find((candidate) => candidate.id === id);
}

export function createSourcePathContext(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  path?: PlatformPath;
  tempRoot?: string;
}): BrowserImportPathContext {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const path = input.path ?? (platform === 'win32' ? nodePath.win32 : nodePath.posix);
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const xdg = env.XDG_CONFIG_HOME;
  const linuxConfigHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  const chromeConfigHome = env.CHROME_CONFIG_HOME;
  return {
    path,
    platform,
    home,
    linuxConfigHome,
    linuxChromeConfigHome:
      chromeConfigHome && path.isAbsolute(chromeConfigHome) ? chromeConfigHome : linuxConfigHome,
    appData: env.APPDATA,
    localAppData: env.LOCALAPPDATA,
    ...(input.tempRoot ? { tempRoot: input.tempRoot } : {}),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function cookieDatabaseCandidatePaths(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string
): string[] {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const profilePath = context.path.isAbsolute(profileDirectory)
    ? profileDirectory
    : context.path.join(root, profileDirectory);
  if (definition.engine === 'firefox') return [context.path.join(profilePath, 'cookies.sqlite')];
  if (definition.engine === 'safari') {
    return [context.path.join(profilePath, 'Cookies.binarycookies')];
  }
  // Chromium 96+ Network/Cookies kullanır; yükseltmeler eski Cookies dosyasını geride bırakır.
  return [
    context.path.join(profilePath, 'Network', 'Cookies'),
    context.path.join(profilePath, 'Cookies'),
  ];
}

export async function resolveCookieDatabase(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string
): Promise<string | undefined> {
  for (const candidate of cookieDatabaseCandidatePaths(definition, context, profileDirectory)) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

/** Yalnızca `[ProfileN]` bölümleri profil tanımlar; `Install*` bölümleri varsayılan seçer. */
export function parseFirefoxProfiles(
  ini: string,
  path: PlatformPath,
  root: string
): BrowserImportSourceProfile[] {
  const profiles: BrowserImportSourceProfile[] = [];
  let current: { name?: string; path?: string; isRelative?: string } | null = null;

  const flush = () => {
    if (current?.path) {
      const candidate = current.path;
      const isRelative = current.isRelative === undefined || current.isRelative === '1';
      const validIsRelative = current.isRelative === undefined || /^[01]$/.test(current.isRelative);
      if (validIsRelative && !candidate.includes('\u0000')) {
        let directory: string | undefined;
        if (isRelative) {
          if (!path.isAbsolute(candidate)) {
            const relative = path.relative(root, path.resolve(root, candidate));
            const escapesRoot =
              relative === '..' ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative);
            if (!escapesRoot) directory = path.normalize(candidate);
          }
        } else if (path.isAbsolute(candidate)) {
          // IsRelative=0 Firefox'un standart dizini dışındaki özel kökleri mümkün kılar.
          directory = path.normalize(candidate);
        }
        if (directory !== undefined) {
          profiles.push({ directory, name: current.name?.trim() || directory });
        }
      }
    }
    current = null;
  };

  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      flush();
      current = /^\[Profile\d+\]$/i.test(line) ? {} : null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'name') current.name = value;
    if (key === 'path') current.path = value;
    if (key === 'isrelative') current.isRelative = value;
  }
  flush();
  return profiles;
}

/** Tarayıcı meta verisi kullanıcı tarafından yazılabilir; dizin geçişi içeren adlar reddedilir. */
export const isSafeProfileDirectory = (directory: string): boolean =>
  directory.length > 0 &&
  directory !== '.' &&
  directory !== '..' &&
  !/[\\/]/.test(directory) &&
  !directory.includes('\u0000');

async function countProfileCookies(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  directory: string
): Promise<number | undefined> {
  if (definition.engine === 'safari') return undefined;
  const database = await resolveCookieDatabase(definition, context, directory);
  if (database === undefined) return undefined;
  try {
    return await withCookieDatabaseSnapshot(
      database,
      (db) => {
        if (definition.engine === 'firefox') {
          const row = db
            .prepare(`select count(*) as count from moz_cookies where originAttributes = ''`)
            .get() as { count: number };
          return row.count;
        }
        if (!hasTable(db, 'cookies')) return 0;
        return (db.prepare('select count(*) as count from cookies').get() as { count: number })
          .count;
      },
      context.tempRoot ? { tempRoot: context.tempRoot } : {}
    );
  } catch {
    return undefined;
  }
}

type ListProfilesOptions = {
  /** Profil başına çerez sayısı (veritabanı kopyalanarak sayılır). Varsayılan: açık. */
  counts?: boolean;
};

async function withCookieCounts(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profiles: BrowserImportSourceProfile[],
  options: ListProfilesOptions
): Promise<BrowserImportSourceProfile[]> {
  if (options.counts === false) return profiles;
  return Promise.all(
    profiles.map(async (profile) => {
      const cookieCount = await countProfileCookies(definition, context, profile.directory);
      return cookieCount === undefined ? profile : { ...profile, cookieCount };
    })
  );
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

const isSafariProfileUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function readSafariDeclaredProfiles(
  metadata: string,
  context: BrowserImportPathContext
): Promise<Array<{ title: string | null; external_uuid: string }>> {
  if (!(await fileExists(metadata))) return [];
  try {
    return await withCookieDatabaseSnapshot(
      metadata,
      (db) =>
        db
          .prepare(
            `select title, external_uuid from bookmarks
              where parent = 0 and type = 1 and subtype = 2 and deleted = 0
              order by order_index`
          )
          .all() as Array<{ title: string | null; external_uuid: string }>,
      context.tempRoot ? { tempRoot: context.tempRoot } : {}
    );
  } catch {
    // Tam Disk Erişimi yoksa meta veri okunamaz; varsayılan profil yine listelenir.
    return [];
  }
}

async function listSafariProfiles(
  context: BrowserImportPathContext,
  root: string
): Promise<BrowserImportSourceProfile[]> {
  const library = context.path.dirname(root);
  const declared = await readSafariDeclaredProfiles(
    context.path.join(library, 'Safari', 'SafariTabs.db'),
    context
  );
  const defaultProfile = declared.find((profile) => profile.external_uuid === 'DefaultProfile');
  const profiles: BrowserImportSourceProfile[] = [
    {
      directory: '.',
      name: defaultProfile ? defaultProfile.title?.trim() || 'Personal' : 'Safari',
    },
  ];
  const stores = context.path.join(library, 'WebKit', 'WebsiteDataStore');
  for (const profile of declared) {
    if (!isSafariProfileUuid(profile.external_uuid)) continue;
    profiles.push({
      directory: context.path.join(stores, profile.external_uuid.toLowerCase(), 'Cookies'),
      name: profile.title?.trim() || profile.external_uuid,
    });
  }
  // Okunabilir meta veri varsa diskte kalmış silinmiş profiller geri getirilmez.
  if (declared.length === 0) {
    const entries = (await readDirectoryNames(stores)).filter(isSafariProfileUuid).sort();
    for (const entry of entries) {
      const directory = context.path.join(stores, entry, 'Cookies');
      if (await fileExists(context.path.join(directory, 'Cookies.binarycookies'))) {
        profiles.push({ directory, name: entry });
      }
    }
  }
  return profiles;
}

async function listSourceProfilesInDirectory(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  options: ListProfilesOptions
): Promise<BrowserImportSourceProfile[]> {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];

  if (definition.engine === 'safari') return listSafariProfiles(context, root);

  if (definition.engine === 'firefox') {
    let declared: BrowserImportSourceProfile[] = [];
    try {
      const ini = await readFile(context.path.join(root, 'profiles.ini'), 'utf8');
      declared = parseFirefoxProfiles(ini, context.path, root);
    } catch {
      declared = [];
    }
    // Beyan edilen profiller eski olabilir; hiçbirinde veritabanı yoksa diski tara.
    if (declared.length > 0) {
      const withDatabase: BrowserImportSourceProfile[] = [];
      for (const profile of declared) {
        if (await resolveCookieDatabase(definition, context, profile.directory)) {
          withDatabase.push(profile);
        }
      }
      if (withDatabase.length > 0)
        return withCookieCounts(definition, context, withDatabase, options);
    }
    const fallbackDirectory =
      context.platform === 'linux' ? root : context.path.join(root, 'Profiles');
    const found: BrowserImportSourceProfile[] = [];
    for (const entry of await readDirectoryNames(fallbackDirectory)) {
      const directory = context.platform === 'linux' ? entry : context.path.join('Profiles', entry);
      if (await resolveCookieDatabase(definition, context, directory)) {
        found.push({ directory, name: entry });
      }
    }
    return withCookieCounts(definition, context, found, options);
  }

  // Chromium: profiller "Local State" içindeki profile.info_cache'te beyan edilir.
  let declared: BrowserImportSourceProfile[] = [];
  try {
    const state = JSON.parse(await readFile(context.path.join(root, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    declared = Object.entries(state.profile?.info_cache ?? {})
      .filter(([directory]) => isSafeProfileDirectory(directory))
      .map(([directory, info]) => ({
        directory,
        name: (typeof info?.name === 'string' ? info.name.trim() : '') || directory,
      }));
  } catch {
    declared = [];
  }
  if (declared.length > 0) return withCookieCounts(definition, context, declared, options);

  const found: BrowserImportSourceProfile[] = [];
  for (const directory of (await readDirectoryNames(root)).filter(isSafeProfileDirectory)) {
    if (await resolveCookieDatabase(definition, context, directory)) {
      found.push({ directory, name: directory });
    }
  }
  return withCookieCounts(definition, context, found, options);
}

/** Alternatif köklerdeki profil yolları mutlak tutulur ki okuma doğru kurulumdan yapılsın. */
export async function listSourceProfiles(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  options: ListProfilesOptions = {}
): Promise<BrowserImportSourceProfile[]> {
  if (definition.engine !== 'firefox' || context.platform !== 'linux') {
    return listSourceProfilesInDirectory(definition, context, options);
  }
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const roots = [root, ...(definition.alternateLinuxRoots?.(context) ?? [])];
  const profiles = new Map<string, BrowserImportSourceProfile>();
  for (const directory of roots) {
    const found = await listSourceProfilesInDirectory(
      { ...definition, userDataDirectory: () => directory },
      context,
      options
    );
    for (const profile of found) {
      const absolute = context.path.resolve(directory, profile.directory);
      if (!profiles.has(absolute)) {
        profiles.set(absolute, directory === root ? profile : { ...profile, directory: absolute });
      }
    }
  }
  return [...profiles.values()];
}

/** Kurulu sayılması için en az bir profilde çerez veritabanı bulunmalıdır. */
export async function isSourceInstalled(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext
): Promise<boolean> {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return false;
  try {
    if (!(await stat(root)).isDirectory()) return false;
  } catch {
    return false;
  }
  const profiles = await listSourceProfiles(definition, context, { counts: false });
  for (const profile of profiles) {
    if (await resolveCookieDatabase(definition, context, profile.directory)) return true;
  }
  return false;
}

export type ProcessLivenessProbe = (pid: number) => boolean;

export const defaultProcessIsAlive: ProcessLivenessProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Yalnızca ESRCH kilidin bayat olduğunu kanıtlar; diğer hatalar çalışan bir tarayıcıyı gizleyebilir.
    return (error as { code?: unknown }).code !== 'ESRCH';
  }
};

/** Chromium `SingletonLock` sembolik bağı `<host>-<pid>` hedefini gösterir. */
export function chromiumSingletonLockIsHeld(
  target: string,
  currentHost: string,
  isProcessAlive: ProcessLivenessProbe
): boolean {
  const separator = target.lastIndexOf('-');
  if (separator <= 0) return true;
  const host = target.slice(0, separator);
  const pidText = target.slice(separator + 1);
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  // Başka makinenin PID'i (paylaşılan ev dizini) burada bayat ilan edilemez.
  if (host !== currentHost) return true;
  return isProcessAlive(pid);
}

/** Firefox `lock` sembolik bağı `<adres>:+<pid>` hedefini gösterir. */
export function firefoxSymlinkLockIsHeld(
  target: string,
  localAddresses: ReadonlySet<string>,
  isProcessAlive: ProcessLivenessProbe
): boolean {
  const separator = target.lastIndexOf(':');
  if (separator < 0) return true;
  const owner = target.slice(0, separator);
  if (!localAddresses.has(owner)) return true;
  const pidText = target.slice(separator + 1).replace(/^\+/, '');
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return isProcessAlive(pid);
}

function localAddresses(): Set<string> {
  const addresses = new Set<string>(['127.0.0.1', '127.0.1.1', '::1']);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address);
  }
  return addresses;
}

export type RunningProbeOptions = {
  currentHost?: string;
  isProcessAlive?: ProcessLivenessProbe;
  localAddresses?: ReadonlySet<string>;
};

/**
 * Kaynak tarayıcı çalışıyor mu? Chromium için `SingletonLock`, Firefox için profil `lock` bağı
 * denetlenir. Safari çerez dosyasını atomik yazar; çalışırken de okunabilir.
 */
export async function isSourceRunning(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  options: RunningProbeOptions = {}
): Promise<boolean> {
  const root = definition.userDataDirectory(context);
  if (root === undefined || definition.engine === 'safari') return false;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;

  if (definition.engine === 'chromium') {
    try {
      const target = await readlink(context.path.join(root, 'SingletonLock'));
      return chromiumSingletonLockIsHeld(target, options.currentHost ?? hostname(), isProcessAlive);
    } catch (error) {
      // Kilit yoksa tarayıcı kapalıdır; başka bir hata (ör. normal dosya) çalışıyor sayılır.
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT') return false;
      try {
        await lstat(context.path.join(root, 'SingletonLock'));
        return true;
      } catch {
        return false;
      }
    }
  }

  const addresses = options.localAddresses ?? localAddresses();
  for (const profile of await listSourceProfiles(definition, context, { counts: false })) {
    const directory = context.path.isAbsolute(profile.directory)
      ? profile.directory
      : context.path.join(root, profile.directory);
    try {
      const target = await readlink(context.path.join(directory, 'lock'));
      if (firefoxSymlinkLockIsHeld(target, addresses, isProcessAlive)) return true;
    } catch {
      // Bağ yoksa bu profil kilitli değildir.
    }
  }
  return false;
}
