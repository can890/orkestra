import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChromiumCookieReadError,
  chromiumSameSite,
  decryptChromiumValue,
  readChromiumCookies,
} from './chromium-cookies';
import {
  ChromiumKeyError,
  createSystemSafeStorageSecretReader,
  deriveChromiumKey,
  LINUX_FALLBACK_PASSPHRASE,
  LINUX_KEY_ITERATIONS,
  MAC_KEY_ITERATIONS,
  resolveChromiumKeys,
  type SafeStorageSecretReader,
} from './chromium-keys';
import {
  chromiumExpirySecondsToUnixSeconds,
  chromiumExpiryToUnixSeconds,
  cookieScope,
  safariExpiryToUnixSeconds,
} from './cookie-model';
import {
  createChromiumCookieDb,
  encryptChromiumValue,
  TEST_SAFE_STORAGE_PASSWORD,
  unixToChromiumMicros,
} from './import-test-fixtures';

const macKey = deriveChromiumKey(TEST_SAFE_STORAGE_PASSWORD, MAC_KEY_ITERATIONS);

describe('epoch conversions', () => {
  it('converts Chromium 1601-based microseconds to UNIX seconds', () => {
    // 2030-01-01T00:00:00Z
    const unix = 1_893_456_000;
    expect(chromiumExpiryToUnixSeconds(unixToChromiumMicros(unix))).toBe(unix);
    expect(chromiumExpirySecondsToUnixSeconds(unix + 11_644_473_600)).toBe(unix);
  });

  it('treats a zero or negative Chromium expiry as a session cookie', () => {
    expect(chromiumExpiryToUnixSeconds(0n)).toBeUndefined();
    expect(chromiumExpirySecondsToUnixSeconds(0)).toBeUndefined();
  });

  it('converts Safari 2001-based seconds to UNIX seconds', () => {
    expect(safariExpiryToUnixSeconds(0)).toBeUndefined();
    expect(safariExpiryToUnixSeconds(1.5)).toBe(978_307_201);
    expect(safariExpiryToUnixSeconds(800_000_000.9)).toBe(1_778_307_200);
  });
});

describe('cookieScope', () => {
  it('keeps host-only cookies without a domain and domain cookies with one', () => {
    expect(cookieScope('example.com', '/', true)).toEqual({
      url: 'https://example.com/',
      domain: undefined,
    });
    expect(cookieScope('.example.com', '/app', false)).toEqual({
      url: 'http://example.com/app',
      domain: '.example.com',
    });
  });

  it('brackets IPv6 hosts', () => {
    expect(cookieScope('::1', '/', false).url).toBe('http://[::1]/');
  });
});

describe('chromium SameSite mapping', () => {
  it('maps the column without widening unknown values', () => {
    expect(chromiumSameSite(-1)).toBe('unspecified');
    expect(chromiumSameSite(0)).toBe('no_restriction');
    expect(chromiumSameSite(1)).toBe('lax');
    expect(chromiumSameSite(2)).toBe('strict');
    expect(chromiumSameSite(7)).toBe('unspecified');
  });
});

describe('decryptChromiumValue', () => {
  it('round-trips a v10 value before the domain-hash schema', () => {
    const encrypted = encryptChromiumValue({
      value: 'session-token',
      key: macKey,
      hostKey: '.example.com',
      schemaVersion: 23,
    });
    expect(decryptChromiumValue(encrypted, { cbcV10: macKey }, '.example.com', 23)).toBe(
      'session-token'
    );
  });

  it('strips the SHA-256 host_key prefix from schema 24 onwards', () => {
    const encrypted = encryptChromiumValue({
      value: 'bound',
      key: macKey,
      hostKey: 'app.example.com',
      schemaVersion: 24,
    });
    expect(decryptChromiumValue(encrypted, { cbcV10: macKey }, 'app.example.com', 24)).toBe(
      'bound'
    );
    // Başka bir alana taşınmış kayıt reddedilir.
    expect(decryptChromiumValue(encrypted, { cbcV10: macKey }, 'evil.example', 24)).toBeNull();
  });

  it('returns null for a wrong key or a missing v11 key', () => {
    const encrypted = encryptChromiumValue({
      value: 'x',
      key: macKey,
      hostKey: 'a.test',
      schemaVersion: 23,
    });
    const otherKey = deriveChromiumKey('other', MAC_KEY_ITERATIONS);
    expect(decryptChromiumValue(encrypted, { cbcV10: otherKey }, 'a.test', 23)).toBeNull();
    const v11 = encryptChromiumValue({
      value: 'x',
      key: macKey,
      hostKey: 'a.test',
      schemaVersion: 23,
      prefix: 'v11',
    });
    expect(decryptChromiumValue(v11, { cbcV10: macKey }, 'a.test', 23)).toBeNull();
  });

  it('falls back to the empty-passphrase key on Linux', () => {
    const emptyKey = deriveChromiumKey('', LINUX_KEY_ITERATIONS);
    const encrypted = encryptChromiumValue({
      value: 'empty',
      key: emptyKey,
      hostKey: 'a.test',
      schemaVersion: 23,
    });
    const keys = {
      cbcV10: deriveChromiumKey(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS),
      cbcEmpty: emptyKey,
    };
    expect(decryptChromiumValue(encrypted, keys, 'a.test', 23)).toBe('empty');
  });
});

describe('resolveChromiumKeys', () => {
  const fakeSecrets = (overrides: Partial<SafeStorageSecretReader> = {}) => {
    const calls: string[] = [];
    const reader: SafeStorageSecretReader = {
      async readMacKeychain(service, account) {
        calls.push(`mac:${service}/${account}`);
        return TEST_SAFE_STORAGE_PASSWORD;
      },
      async readLinuxSecret(application) {
        calls.push(`linux:${application}`);
        throw new ChromiumKeyError('keychainItemMissing');
      },
      ...overrides,
    };
    return { reader, calls };
  };

  it('derives the macOS key from the injected keychain reader', async () => {
    const { reader, calls } = fakeSecrets();
    const keys = await resolveChromiumKeys(
      {
        platform: 'darwin',
        keychainService: 'Chrome Safe Storage',
        keychainAccount: 'Chrome',
        linuxSecretApplication: undefined,
      },
      reader
    );
    expect(calls).toEqual(['mac:Chrome Safe Storage/Chrome']);
    expect(keys.cbcV10?.equals(macKey)).toBe(true);
  });

  it('propagates a keychain denial', async () => {
    const { reader } = fakeSecrets({
      readMacKeychain: async () => {
        throw new ChromiumKeyError('needsKeychainApproval');
      },
    });
    await expect(
      resolveChromiumKeys(
        {
          platform: 'darwin',
          keychainService: 'Chrome Safe Storage',
          keychainAccount: 'Chrome',
          linuxSecretApplication: undefined,
        },
        reader
      )
    ).rejects.toMatchObject({ reason: 'needsKeychainApproval' });
  });

  it('keeps v10 usable on Linux when the keyring item is missing', async () => {
    const { reader } = fakeSecrets();
    const keys = await resolveChromiumKeys(
      {
        platform: 'linux',
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: 'chrome',
      },
      reader
    );
    expect(keys.cbcV10).toBeDefined();
    expect(keys.cbcV11).toBeUndefined();
    expect(keys.cbcV11Error?.reason).toBe('keychainItemMissing');
  });

  it('rejects Windows Chromium imports', async () => {
    const { reader } = fakeSecrets();
    await expect(
      resolveChromiumKeys(
        {
          platform: 'win32',
          keychainService: 'x',
          keychainAccount: 'y',
          linuxSecretApplication: undefined,
        },
        reader
      )
    ).rejects.toMatchObject({ reason: 'unsupportedPlatform' });
  });
});

describe('createSystemSafeStorageSecretReader', () => {
  it('maps security exit codes without touching the real keychain', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const reader = createSystemSafeStorageSecretReader((file, args, callback) => {
      calls.push({ file, args });
      const service = args[args.indexOf('-s') + 1];
      if (service === 'Missing') {
        callback(Object.assign(new Error('missing'), { code: 44 }), '');
      } else if (service === 'Denied') {
        callback(Object.assign(new Error('denied'), { code: 51 }), '');
      } else {
        callback(null, 'secret\n');
      }
    });
    await expect(reader.readMacKeychain('Chrome Safe Storage', 'Chrome')).resolves.toBe('secret');
    expect(calls[0]).toEqual({
      file: '/usr/bin/security',
      args: ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
    });
    await expect(reader.readMacKeychain('Missing', 'x')).rejects.toMatchObject({
      reason: 'keychainItemMissing',
    });
    await expect(reader.readMacKeychain('Denied', 'x')).rejects.toMatchObject({
      reason: 'needsKeychainApproval',
    });
  });
});

describe('readChromiumCookies (fixture database)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orkestra-chromium-fixture-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('decrypts, maps and skips partitioned rows from a schema 24 database copy', async () => {
    const dbPath = join(dir, 'Default', 'Network', 'Cookies');
    const expires = 1_893_456_000;
    createChromiumCookieDb(dbPath, {
      schemaVersion: 24,
      rows: [
        {
          hostKey: '.example.com',
          name: 'sid',
          encryptedValue: encryptChromiumValue({
            value: 'abc',
            key: macKey,
            hostKey: '.example.com',
            schemaVersion: 24,
          }),
          expiresUtc: unixToChromiumMicros(expires),
          secure: true,
          httpOnly: true,
          sameSite: 1,
        },
        { hostKey: 'host.example.com', name: '__Host-plain', value: 'plain', secure: true },
        {
          hostKey: 'embed.test',
          name: 'chips',
          encryptedValue: encryptChromiumValue({
            value: 'p',
            key: macKey,
            hostKey: 'embed.test',
            schemaVersion: 24,
          }),
          topFrameSiteKey: 'https://top.test',
        },
        {
          hostKey: 'broken.test',
          name: 'bad',
          encryptedValue: Buffer.from('v10garbage-not-a-block'),
        },
      ],
    });

    const result = await readChromiumCookies(dbPath, { cbcV10: macKey }, { tempRoot: dir });
    expect(result.cookies).toEqual([
      {
        url: 'https://example.com/',
        name: 'sid',
        value: 'abc',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expirationDate: expires,
        sameSite: 'lax',
      },
      {
        url: 'https://host.example.com/',
        name: '__Host-plain',
        value: 'plain',
        domain: undefined,
        path: '/',
        secure: true,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: 'unspecified',
      },
    ]);
    expect(result.partitioned).toBe(1);
    expect(result.undecryptable).toBe(1);
    expect(result.skippedHosts.sort()).toEqual(['broken.test', 'embed.test']);
  });

  it('reads pre-partition-key databases (schema < 15)', async () => {
    const dbPath = join(dir, 'Cookies');
    createChromiumCookieDb(dbPath, {
      schemaVersion: 12,
      rows: [
        {
          hostKey: 'old.test',
          name: 'n',
          encryptedValue: encryptChromiumValue({
            value: 'v',
            key: macKey,
            hostKey: 'old.test',
            schemaVersion: 12,
          }),
          sameSite: 2,
        },
      ],
    });
    const result = await readChromiumCookies(dbPath, { cbcV10: macKey }, { tempRoot: dir });
    expect(result.cookies.map((c) => [c.name, c.value, c.sameSite])).toEqual([
      ['n', 'v', 'strict'],
    ]);
  });

  it('reports a v11 keyring failure when nothing could be decrypted', async () => {
    const dbPath = join(dir, 'Cookies');
    createChromiumCookieDb(dbPath, {
      schemaVersion: 23,
      rows: [
        {
          hostKey: 'a.test',
          name: 'n',
          encryptedValue: encryptChromiumValue({
            value: 'v',
            key: macKey,
            hostKey: 'a.test',
            schemaVersion: 23,
            prefix: 'v11',
          }),
        },
      ],
    });
    await expect(
      readChromiumCookies(
        dbPath,
        { cbcV10: macKey, cbcV11Error: new ChromiumKeyError('keychainUnavailable') },
        { tempRoot: dir }
      )
    ).rejects.toBeInstanceOf(ChromiumCookieReadError);
  });

  it('fails with readFailed for a missing database', async () => {
    await expect(
      readChromiumCookies(join(dir, 'nope'), { cbcV10: macKey }, { tempRoot: dir })
    ).rejects.toMatchObject({ reason: 'readFailed' });
  });
});
