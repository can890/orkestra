import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBrowserImportService,
  writeCookies,
  type CookieWriteTarget,
} from './browser-import-service';
import {
  ChromiumKeyError,
  deriveChromiumKey,
  MAC_KEY_ITERATIONS,
  type SafeStorageSecretReader,
} from './chromium-keys';
import {
  buildBinaryCookies,
  createChromiumCookieDb,
  createFirefoxCookieDb,
  encryptChromiumValue,
  TEST_SAFE_STORAGE_PASSWORD,
  unixToChromiumMicros,
} from './import-test-fixtures';
import {
  chromiumSingletonLockIsHeld,
  createSourcePathContext,
  findBrowserImportSource,
  firefoxSymlinkLockIsHeld,
  isSourceRunning,
  listSourceProfiles,
  parseFirefoxProfiles,
} from './sources';

const NOW_SECONDS = 1_800_000_000;
const FUTURE = NOW_SECONDS + 86_400;
const PAST = NOW_SECONDS - 86_400;

type SetCall = Parameters<CookieWriteTarget['cookies']['set']>[0];

function fakeSession(options: { reject?: (details: SetCall) => boolean } = {}) {
  const calls: SetCall[] = [];
  let flushed = 0;
  const target: CookieWriteTarget = {
    cookies: {
      async set(details) {
        if (options.reject?.(details)) throw new Error('rejected');
        calls.push(details);
      },
      async flushStore() {
        flushed += 1;
      },
    },
  };
  return { target, calls, flushCount: () => flushed };
}

let home: string;
let temp: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orkestra-fake-home-'));
  temp = mkdtempSync(join(tmpdir(), 'orkestra-import-temp-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

function macContext() {
  return createSourcePathContext({ platform: 'darwin', env: { HOME: home }, tempRoot: temp });
}

const appSupport = (...segments: string[]) =>
  join(home, 'Library', 'Application Support', ...segments);

function writeChromeFixture() {
  const root = appSupport('Google', 'Chrome');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Personal' },
          'Profile 1': { name: 'Work' },
          '../escape': { name: 'Bad' },
        },
      },
    })
  );
  const key = deriveChromiumKey(TEST_SAFE_STORAGE_PASSWORD, MAC_KEY_ITERATIONS);
  const enc = (value: string, hostKey: string) =>
    encryptChromiumValue({ value, key, hostKey, schemaVersion: 24 });
  createChromiumCookieDb(join(root, 'Default', 'Network', 'Cookies'), {
    schemaVersion: 24,
    rows: [
      {
        hostKey: '.github.test',
        name: 'user_session',
        encryptedValue: enc('s3cr3t', '.github.test'),
        expiresUtc: unixToChromiumMicros(FUTURE),
        secure: true,
        httpOnly: true,
        sameSite: 1,
      },
      {
        hostKey: 'app.test',
        name: '__Host-csrf',
        encryptedValue: enc('csrf', 'app.test'),
        secure: true,
        sameSite: 2,
      },
      {
        hostKey: 'old.test',
        name: 'expired',
        encryptedValue: enc('gone', 'old.test'),
        expiresUtc: unixToChromiumMicros(PAST),
      },
      {
        hostKey: 'embed.test',
        name: 'chips',
        encryptedValue: enc('p', 'embed.test'),
        topFrameSiteKey: 'https://top.test',
      },
    ],
  });
  // Profile 1 eski (Network öncesi) konumda.
  createChromiumCookieDb(join(root, 'Profile 1', 'Cookies'), { schemaVersion: 20, rows: [] });
  return root;
}

function writeFirefoxFixture() {
  const root = appSupport('Firefox');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'profiles.ini'),
    [
      '[Install4F96D1932A9F858E]',
      'Default=Profiles/abc.default-release',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=Profiles/abc.default-release',
      '[Profile1]',
      'Name=escape',
      'IsRelative=1',
      'Path=../../etc',
    ].join('\n')
  );
  createFirefoxCookieDb(join(root, 'Profiles', 'abc.default-release', 'cookies.sqlite'), {
    userVersion: 16,
    rows: [
      { host: '.mozilla.test', name: 'sid', value: 'ff', expiry: FUTURE * 1000, sameSite: 0 },
      { host: 'c.test', name: 'c', value: 'x', originAttributes: '^userContextId=2' },
    ],
  });
  return root;
}

function writeSafariFixture() {
  const jarDir = join(
    home,
    'Library',
    'Containers',
    'com.apple.Safari',
    'Data',
    'Library',
    'Cookies'
  );
  mkdirSync(jarDir, { recursive: true });
  writeFileSync(
    join(jarDir, 'Cookies.binarycookies'),
    buildBinaryCookies([
      [
        { domain: '.apple.test', name: 'a', value: '1', expiresUnix: FUTURE, secure: true },
        { domain: 'old.test', name: 'b', value: '2', expiresUnix: PAST },
      ],
    ])
  );
}

const fakeSecrets = (): SafeStorageSecretReader & { macCalls: string[] } => {
  const macCalls: string[] = [];
  return {
    macCalls,
    async readMacKeychain(service, account) {
      macCalls.push(`${service}/${account}`);
      return TEST_SAFE_STORAGE_PASSWORD;
    },
    async readLinuxSecret() {
      throw new Error('not used');
    },
  };
};

describe('profile discovery (fake home directory)', () => {
  it('lists Chromium profiles from Local State, rejecting traversal, with cookie counts', async () => {
    writeChromeFixture();
    const chrome = findBrowserImportSource('chrome')!;
    const profiles = await listSourceProfiles(chrome, macContext());
    expect(profiles).toEqual([
      { directory: 'Default', name: 'Personal', cookieCount: 4 },
      { directory: 'Profile 1', name: 'Work', cookieCount: 0 },
    ]);
  });

  it('lists Firefox profiles from profiles.ini and ignores escaping paths', async () => {
    writeFirefoxFixture();
    const firefox = findBrowserImportSource('firefox')!;
    const profiles = await listSourceProfiles(firefox, macContext());
    expect(profiles).toEqual([
      { directory: 'Profiles/abc.default-release', name: 'default-release', cookieCount: 1 },
    ]);
  });

  it('parses profiles.ini with absolute (IsRelative=0) entries', () => {
    const parsed = parseFirefoxProfiles(
      '[Profile0]\nName=Custom\nIsRelative=0\nPath=/data/ff\n[Profile1]\nPath=rel\n',
      nodePath.posix,
      '/root'
    );
    expect(parsed).toEqual([
      { directory: '/data/ff', name: 'Custom' },
      { directory: 'rel', name: 'rel' },
    ]);
  });

  it('lists the default Safari profile when the jar exists', async () => {
    writeSafariFixture();
    const safari = findBrowserImportSource('safari')!;
    expect(await listSourceProfiles(safari, macContext())).toEqual([
      { directory: '.', name: 'Safari' },
    ]);
  });
});

describe('running-browser detection', () => {
  it('interprets Chromium SingletonLock targets', () => {
    const alive = () => true;
    const dead = () => false;
    expect(chromiumSingletonLockIsHeld('myhost-123', 'myhost', alive)).toBe(true);
    expect(chromiumSingletonLockIsHeld('myhost-123', 'myhost', dead)).toBe(false);
    expect(chromiumSingletonLockIsHeld('otherhost-123', 'myhost', dead)).toBe(true);
    expect(chromiumSingletonLockIsHeld('garbage', 'myhost', dead)).toBe(true);
  });

  it('interprets Firefox lock symlink targets', () => {
    const local = new Set(['127.0.0.1']);
    expect(firefoxSymlinkLockIsHeld('127.0.0.1:+42', local, () => true)).toBe(true);
    expect(firefoxSymlinkLockIsHeld('127.0.0.1:+42', local, () => false)).toBe(false);
    expect(firefoxSymlinkLockIsHeld('10.0.0.9:+42', local, () => false)).toBe(true);
  });

  it('reports a running Chromium browser from its SingletonLock symlink', async () => {
    const root = writeChromeFixture();
    symlinkSync('testhost-4242', join(root, 'SingletonLock'));
    const chrome = findBrowserImportSource('chrome')!;
    const running = await isSourceRunning(chrome, macContext(), {
      currentHost: 'testhost',
      isProcessAlive: (pid) => pid === 4242,
    });
    expect(running).toBe(true);
  });
});

describe('writeCookies', () => {
  it('maps host-only vs domain cookies, skips expired and counts rejections', async () => {
    const { target, calls, flushCount } = fakeSession({
      reject: (details) => details.name === 'rejected',
    });
    const summary = await writeCookies(
      target,
      {
        cookies: [
          {
            url: 'https://host.test/',
            name: '__Host-a',
            value: 'v',
            domain: undefined,
            path: '/',
            secure: true,
            httpOnly: true,
            expirationDate: undefined,
            sameSite: 'strict',
          },
          {
            url: 'http://d.test/',
            name: 'b',
            value: 'v',
            domain: '.d.test',
            path: '/',
            secure: false,
            httpOnly: false,
            expirationDate: FUTURE,
            sameSite: 'no_restriction',
          },
          {
            url: 'http://x.test/',
            name: 'expired',
            value: 'v',
            domain: undefined,
            path: '/',
            secure: false,
            httpOnly: false,
            expirationDate: PAST,
            sameSite: 'lax',
          },
          {
            url: 'http://r.test/',
            name: 'rejected',
            value: 'v',
            domain: undefined,
            path: '/',
            secure: false,
            httpOnly: false,
            expirationDate: undefined,
            sameSite: 'lax',
          },
          {
            url: 'not a url',
            name: 'bad',
            value: 'v',
            domain: undefined,
            path: '/',
            secure: false,
            httpOnly: false,
            expirationDate: undefined,
            sameSite: 'lax',
          },
        ],
        undecryptable: 2,
        partitioned: 1,
        skippedHosts: ['p.test'],
      },
      NOW_SECONDS * 1000
    );
    expect(calls).toEqual([
      {
        url: 'https://host.test/',
        name: '__Host-a',
        value: 'v',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
      },
      {
        url: 'http://d.test/',
        name: 'b',
        value: 'v',
        domain: '.d.test',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'no_restriction',
        expirationDate: FUTURE,
      },
    ]);
    expect(calls[0]).not.toHaveProperty('domain');
    expect(calls[0]).not.toHaveProperty('expirationDate');
    expect(summary).toEqual({
      imported: 2,
      skipped: 6,
      skippedExpired: 1,
      skippedPartitioned: 1,
      skippedUndecryptable: 2,
      skippedRejected: 2,
      skippedDomains: ['p.test', 'r.test', 'not a url'],
    });
    expect(flushCount()).toBe(1);
  });
});

describe('browser import service (end to end over fixtures)', () => {
  function makeService(targets: Record<string, CookieWriteTarget>) {
    const secrets = fakeSecrets();
    const service = createBrowserImportService({
      context: macContext(),
      secrets,
      getTargetSession: async (profileId) => targets[profileId],
      running: { currentHost: 'testhost', isProcessAlive: () => false },
      now: () => NOW_SECONDS * 1000,
    });
    return { service, secrets };
  }

  it('lists only installed sources as available on macOS', async () => {
    writeChromeFixture();
    writeFirefoxFixture();
    const { service, secrets } = makeService({});
    const sources = await service.listSources();
    const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
    expect(byId.chrome.unavailable).toBeUndefined();
    expect(byId.chrome.profiles.map((p) => p.name)).toEqual(['Personal', 'Work']);
    expect(byId.firefox.unavailable).toBeUndefined();
    expect(byId.brave.unavailable).toBe('notInstalled');
    expect(byId.safari.unavailable).toBe('notInstalled');
    // Listeleme anahtar zincirine hiç dokunmaz.
    expect(secrets.macCalls).toEqual([]);
  });

  it('imports Chrome cookies into the target profile session and summarises', async () => {
    writeChromeFixture();
    const session = fakeSession();
    const { service, secrets } = makeService({ work: session.target });
    const result = await service.importCookies({
      sourceId: 'chrome',
      sourceProfileDirectory: 'Default',
      targetProfileId: 'work',
    });
    expect(result).toEqual({
      success: true,
      summary: {
        imported: 2,
        skipped: 2,
        skippedExpired: 1,
        skippedPartitioned: 1,
        skippedUndecryptable: 0,
        skippedRejected: 0,
        skippedDomains: ['embed.test'],
      },
    });
    expect(secrets.macCalls).toEqual(['Chrome Safe Storage/Chrome']);
    expect(session.calls.map((c) => [c.name, c.value, c.domain, c.sameSite])).toEqual([
      ['user_session', 's3cr3t', '.github.test', 'lax'],
      ['__Host-csrf', 'csrf', undefined, 'strict'],
    ]);
    expect(session.calls[0].expirationDate).toBe(FUTURE);
  });

  it('imports Firefox and Safari fixtures', async () => {
    writeFirefoxFixture();
    writeSafariFixture();
    const session = fakeSession();
    const { service, secrets } = makeService({ default: session.target });
    const firefox = await service.importCookies({
      sourceId: 'firefox',
      sourceProfileDirectory: 'Profiles/abc.default-release',
      targetProfileId: 'default',
    });
    expect(firefox).toMatchObject({
      success: true,
      summary: { imported: 1, skippedPartitioned: 1 },
    });
    const safari = await service.importCookies({
      sourceId: 'safari',
      sourceProfileDirectory: '.',
      targetProfileId: 'default',
    });
    expect(safari).toMatchObject({ success: true, summary: { imported: 1, skippedExpired: 1 } });
    expect(session.calls.map((c) => c.name)).toEqual(['sid', 'a']);
    expect(secrets.macCalls).toEqual([]);
  });

  it('refuses unknown source profiles, unknown targets and running browsers', async () => {
    const root = writeChromeFixture();
    const session = fakeSession();
    const { service, secrets } = makeService({ work: session.target });
    expect(
      await service.importCookies({
        sourceId: 'chrome',
        sourceProfileDirectory: '../escape',
        targetProfileId: 'work',
      })
    ).toEqual({ success: false, reason: 'unknownSourceProfile' });
    expect(
      await service.importCookies({
        sourceId: 'chrome',
        sourceProfileDirectory: 'Default',
        targetProfileId: 'missing',
      })
    ).toEqual({ success: false, reason: 'unknownTargetProfile' });

    symlinkSync('testhost-99', join(root, 'SingletonLock'));
    const running = createBrowserImportService({
      context: macContext(),
      secrets,
      getTargetSession: async () => session.target,
      running: { currentHost: 'testhost', isProcessAlive: () => true },
    });
    expect(
      await running.importCookies({
        sourceId: 'chrome',
        sourceProfileDirectory: 'Default',
        targetProfileId: 'work',
      })
    ).toEqual({ success: false, reason: 'browserRunning' });
    expect(session.calls).toEqual([]);
    expect(secrets.macCalls).toEqual([]);
  });

  it('surfaces a keychain denial without writing anything', async () => {
    writeChromeFixture();
    const session = fakeSession();
    const service = createBrowserImportService({
      context: macContext(),
      secrets: {
        async readMacKeychain() {
          throw new ChromiumKeyError('needsKeychainApproval');
        },
        async readLinuxSecret() {
          throw new Error('not used');
        },
      },
      getTargetSession: async () => session.target,
      running: { currentHost: 'testhost', isProcessAlive: () => false },
    });
    expect(
      await service.importCookies({
        sourceId: 'chrome',
        sourceProfileDirectory: 'Default',
        targetProfileId: 'work',
      })
    ).toEqual({ success: false, reason: 'needsKeychainApproval' });
    expect(session.calls).toEqual([]);
  });

  it('hides sources that are not supported on the platform', async () => {
    const service = createBrowserImportService({
      context: createSourcePathContext({ platform: 'win32', env: { USERPROFILE: home } }),
      secrets: fakeSecrets(),
      getTargetSession: async () => undefined,
    });
    const ids = (await service.listSources()).map((source) => source.id);
    expect(ids).toEqual(['firefox', 'zen']);
  });
});
