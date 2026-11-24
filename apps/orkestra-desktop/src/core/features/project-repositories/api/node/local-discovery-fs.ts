import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveryEntryKind, RepositoryDiscoveryFs } from '../discovery';

const MAX_TEXT_BYTES = 256 * 1024;

function kindOf(entry: { isDirectory(): boolean; isFile(): boolean }): DiscoveryEntryKind {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

/** Yerel makinedeki depo keşfi için `node:fs` tabanlı port. */
export function createLocalDiscoveryFs(): RepositoryDiscoveryFs {
  const statKind = async (target: string): Promise<DiscoveryEntryKind | null> => {
    try {
      return kindOf(await stat(target));
    } catch {
      return null;
    }
  };
  return {
    async readDirectory(folder) {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        return null;
      }
      return Promise.all(
        entries.map(async (entry) => {
          if (!entry.isSymbolicLink()) {
            return { name: entry.name, kind: kindOf(entry), isSymlink: false };
          }
          const kind = await statKind(path.join(folder, entry.name));
          return { name: entry.name, kind: kind ?? 'other', isSymlink: true };
        })
      );
    },
    statKind,
    async realPath(target) {
      try {
        return await realpath(target);
      } catch {
        return null;
      }
    },
    async readText(target) {
      try {
        const info = await stat(target);
        if (!info.isFile() || info.size > MAX_TEXT_BYTES) return null;
        return await readFile(target, 'utf8');
      } catch {
        return null;
      }
    },
    join: (...parts) => path.join(...parts),
    resolve: (base, target) => path.resolve(base, target),
  };
}
