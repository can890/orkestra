import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertChecksumMatches, expectedChecksum, parseSha256Sums, sha256File } from './checksums';

const ZIP = '89ccfb26e4d9d3cb2be9ee8fe39eb6143f4d7a8d4235c85bc152326f1b95cf6f';
const DMG = '4b9ec734a8c663254ee22dad159eb1db3ff116362bd7c35f39abaa4b3fdfe831';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('parseSha256Sums', () => {
  it('reads shasum output, binary markers, paths, comments and CRLF', () => {
    const sums = parseSha256Sums(
      `# Orkestra 1.2.21\r\n${DMG}  orkestra-arm64.dmg\r\n${ZIP.toUpperCase()} *./dist/orkestra-arm64.zip\n\nnot a line\n`
    );
    expect(sums.get('orkestra-arm64.dmg')).toBe(DMG);
    expect(sums.get('orkestra-arm64.zip')).toBe(ZIP);
    expect(sums.size).toBe(2);
  });

  it('rejects conflicting digests for the same file', () => {
    expect(() =>
      parseSha256Sums(`${ZIP}  orkestra-arm64.zip\n${DMG}  orkestra-arm64.zip\n`)
    ).toThrow('çelişkili');
  });

  it('ignores digests of the wrong length', () => {
    expect(parseSha256Sums(`${ZIP.slice(1)}  orkestra-arm64.zip`).size).toBe(0);
  });
});

describe('expectedChecksum', () => {
  it('returns the digest of the requested asset or explains what is missing', () => {
    const text = `${DMG}  orkestra-arm64.dmg\n${ZIP}  orkestra-arm64.zip\n`;
    expect(expectedChecksum(text, 'orkestra-arm64.zip')).toBe(ZIP);
    expect(() => expectedChecksum(text, 'orkestra-x64.zip')).toThrow(
      'orkestra-x64.zip için özet bulunamadı'
    );
  });
});

describe('sha256File / assertChecksumMatches', () => {
  it('hashes a file and accepts only the matching digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orkestra-checksum-'));
    dirs.push(dir);
    const file = join(dir, 'orkestra-arm64.zip');
    await writeFile(file, 'hello\n');
    const digest = await sha256File(file);
    expect(digest).toBe('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03');

    expect(() => assertChecksumMatches(digest.toUpperCase(), digest, 'x')).not.toThrow();
    expect(() => assertChecksumMatches(digest, ZIP, 'orkestra-arm64.zip')).toThrow(
      'SHA256SUMS ile eşleşmiyor'
    );
  });
});
