import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirInside, PluginPathError, readFileInside, resolveInside } from './safe-path';

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'plugin-safe-path-'));
  root = join(base, 'plugin');
  await mkdir(join(root, 'skills'), { recursive: true });
  await writeFile(join(root, 'skills', 'a.md'), 'icerik');
  await writeFile(join(base, 'secret.txt'), 'gizli');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('kök içindeki dosyayı çözer, olmayanı null döner', async () => {
    expect(await resolveInside(root, 'skills/a.md')).toContain('a.md');
    expect(await resolveInside(root, 'skills/yok.md')).toBeNull();
  });

  it('.. ile çıkışı ve mutlak yolu reddeder', async () => {
    await expect(resolveInside(root, '../secret.txt')).rejects.toBeInstanceOf(PluginPathError);
    await expect(resolveInside(root, 'skills/../../secret.txt')).rejects.toBeInstanceOf(
      PluginPathError
    );
    await expect(resolveInside(root, join(base, 'secret.txt'))).rejects.toBeInstanceOf(
      PluginPathError
    );
    await expect(resolveInside(root, 'a\0b')).rejects.toBeInstanceOf(PluginPathError);
  });

  it('kök dışına işaret eden symlink dosyasını reddeder', async () => {
    await symlink(join(base, 'secret.txt'), join(root, 'skills', 'link.md'));
    await expect(readFileInside(root, 'skills/link.md', 1000)).rejects.toBeInstanceOf(
      PluginPathError
    );
  });

  it('kök dışına işaret eden symlink dizinini reddeder', async () => {
    await symlink(base, join(root, 'out'));
    await expect(resolveInside(root, 'out/secret.txt')).rejects.toBeInstanceOf(PluginPathError);
  });
});

describe('readFileInside', () => {
  it('boyut sınırını uygular', async () => {
    await expect(readFileInside(root, 'skills/a.md', 2)).rejects.toBeInstanceOf(PluginPathError);
    expect(await readFileInside(root, 'skills/a.md', 100)).toBe('icerik');
  });
});

describe('listDirInside', () => {
  it('dışarı çıkan symlink girdilerini atlar', async () => {
    await symlink(base, join(root, 'skills', 'out'));
    const entries = await listDirInside(root, 'skills');
    expect(entries?.map((e) => e.name)).toEqual(['a.md']);
  });
});
