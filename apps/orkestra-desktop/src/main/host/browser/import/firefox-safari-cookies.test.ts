import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firefoxExpiryToUnixSeconds, firefoxSameSite, readFirefoxCookies } from './firefox-cookies';
import { buildBinaryCookies, createFirefoxCookieDb } from './import-test-fixtures';
import { parseBinaryCookies, readSafariCookies } from './safari-cookies';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orkestra-cookie-fixture-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('firefox cookies', () => {
  it('maps SameSite including the rawSameSite quirk of schemas 10-14', () => {
    expect(firefoxSameSite(null, null)).toBe('unspecified');
    expect(firefoxSameSite(0, null)).toBe('no_restriction');
    expect(firefoxSameSite(1, 0)).toBe('unspecified');
    expect(firefoxSameSite(1, 1)).toBe('lax');
    expect(firefoxSameSite(2, null)).toBe('strict');
    expect(firefoxSameSite(9, null)).toBe('unspecified');
  });

  it('converts expiry seconds (old schemas) and milliseconds (schema 16+)', () => {
    expect(firefoxExpiryToUnixSeconds(1_893_456_000, 12)).toBe(1_893_456_000);
    expect(firefoxExpiryToUnixSeconds(1_893_456_000_123, 16)).toBe(1_893_456_000);
    expect(firefoxExpiryToUnixSeconds(0, 16)).toBeUndefined();
  });

  it('reads the default container only from a schema 16 database copy', async () => {
    const dbPath = join(dir, 'cookies.sqlite');
    createFirefoxCookieDb(dbPath, {
      userVersion: 16,
      rows: [
        {
          host: '.mozilla.test',
          name: 'sid',
          value: 'v1',
          expiry: 1_893_456_000_000,
          secure: true,
          httpOnly: true,
          sameSite: 2,
        },
        { host: 'host.test', name: 'plain', value: 'v2', sameSite: 1, path: '/a' },
        {
          host: 'container.test',
          name: 'c',
          value: 'x',
          originAttributes: '^userContextId=1',
        },
        {
          host: 'partitioned.test',
          name: 'p',
          value: 'y',
          originAttributes: '^partitionKey=%28https%2Ctop.test%29',
        },
      ],
    });
    const result = await readFirefoxCookies(dbPath, { tempRoot: dir });
    expect(result.cookies).toEqual([
      {
        url: 'https://mozilla.test/',
        name: 'sid',
        value: 'v1',
        domain: '.mozilla.test',
        path: '/',
        secure: true,
        httpOnly: true,
        expirationDate: 1_893_456_000,
        sameSite: 'strict',
      },
      {
        url: 'http://host.test/a',
        name: 'plain',
        value: 'v2',
        domain: undefined,
        path: '/a',
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: 'lax',
      },
    ]);
    expect(result.partitioned).toBe(2);
    expect(result.skippedHosts.sort()).toEqual(['container.test', 'partitioned.test']);
  });

  it('honours rawSameSite on schema 12', async () => {
    const dbPath = join(dir, 'cookies.sqlite');
    createFirefoxCookieDb(dbPath, {
      userVersion: 12,
      rows: [{ host: 'a.test', name: 'n', value: 'v', sameSite: 1, rawSameSite: 0, expiry: 5 }],
    });
    const result = await readFirefoxCookies(dbPath, { tempRoot: dir });
    expect(result.cookies[0]).toMatchObject({ sameSite: 'unspecified', expirationDate: 5 });
  });
});

describe('safari binarycookies', () => {
  it('parses a hand-built multi-page file', () => {
    const buffer = buildBinaryCookies([
      [
        {
          domain: '.apple.test',
          name: 'sid',
          value: 'one',
          expiresUnix: 1_893_456_000,
          secure: true,
          httpOnly: true,
        },
        { domain: 'host.test', name: 'session', value: 'two', path: '/p' },
      ],
      [{ domain: 'second.test', name: 'n', value: 'three' }],
    ]);
    expect(parseBinaryCookies(buffer)).toEqual([
      {
        url: 'https://apple.test/',
        domain: '.apple.test',
        name: 'sid',
        value: 'one',
        path: '/',
        secure: true,
        httpOnly: true,
        expirationDate: 1_893_456_000,
        sameSite: 'lax',
      },
      {
        url: 'http://host.test/p',
        domain: undefined,
        name: 'session',
        value: 'two',
        path: '/p',
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: 'lax',
      },
      {
        url: 'http://second.test/',
        domain: undefined,
        name: 'n',
        value: 'three',
        path: '/',
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: 'lax',
      },
    ]);
  });

  it('rejects bad magic, truncated pages and an invalid trailer', () => {
    const good = buildBinaryCookies([[{ domain: 'a.test', name: 'n', value: 'v' }]]);
    const badMagic = Buffer.from(good);
    badMagic.write('nope', 0, 'latin1');
    expect(() => parseBinaryCookies(badMagic)).toThrow();
    expect(() => parseBinaryCookies(good.subarray(0, good.length - 20))).toThrow();
    expect(() => parseBinaryCookies(Buffer.concat([good, Buffer.alloc(3)]))).toThrow();
  });

  it('reads a jar from disk', async () => {
    const jar = join(dir, 'Cookies.binarycookies');
    writeFileSync(jar, buildBinaryCookies([[{ domain: 'a.test', name: 'n', value: 'v' }]]));
    const result = await readSafariCookies(jar);
    expect(result.cookies).toHaveLength(1);
    await expect(readSafariCookies(join(dir, 'missing'))).rejects.toMatchObject({
      reason: 'readFailed',
    });
  });
});
