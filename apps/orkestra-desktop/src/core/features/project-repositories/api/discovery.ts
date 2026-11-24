// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/workspace/WorkspaceFolders.ts
//
// Bir proje klasörünün kapsadığı Git depolarını diskten bulur. Liste saklanmaz; her çağrıda diskten
// okunur, böylece klasöre klonlanan bir depo hemen projeye girer, silinen hemen çıkar.
//
// Kurallar:
// - Bir alt klasör kendi `.git` DİZİNİNE sahipse depodur.
// - `.git`'i dosya olan klasör başka bir deponun worktree'si ya da alt modülüdür; tarama onu almaz
//   (alt modüller aşağıda `.gitmodules` üzerinden ayrıca eklenir).
// - Depo olmayan bir alt klasörün (ör. `src`, `packages`) bir seviye daha içine bakılır.
// - Nokta ile başlayan klasörler ve `node_modules` atlanır.
// - Gerçek yolu (symlink çözülmüş) proje klasörünün dışına çıkan ya da aynı depoya ikinci kez
//   varan girişler alınmaz.
// - Depoların (ve kök deponun) `.gitmodules` dosyasında tanımlı, başlatılmış alt modüller
//   `submodule` türüyle listelenir.
//
// Bu modül saf mantıktır: dosya sistemine yalnızca `RepositoryDiscoveryFs` portu üzerinden erişir.

/** Bir projenin kapsayabileceği en fazla depo sayısı (T3 ile aynı sınır). */
export const MAX_DISCOVERED_REPOSITORIES = 128;

export type DiscoveryEntryKind = 'directory' | 'file' | 'other';

export type DiscoveryDirectoryEntry = Readonly<{
  name: string;
  /** Symlink'ler izlenerek belirlenen tür. */
  kind: DiscoveryEntryKind;
  isSymlink: boolean;
}>;

/** Keşfin ihtiyaç duyduğu dosya sistemi ve yol işlemleri. */
export interface RepositoryDiscoveryFs {
  /** Dizinin çocukları; okunamazsa `null`. */
  readDirectory(path: string): Promise<readonly DiscoveryDirectoryEntry[] | null>;
  /** Yolun (symlink izlenerek) türü; yoksa `null`. */
  statKind(path: string): Promise<DiscoveryEntryKind | null>;
  /** Symlink'leri çözülmüş gerçek yol; çözülemezse `null`. */
  realPath(path: string): Promise<string | null>;
  /** Metin dosyası içeriği; okunamazsa `null`. */
  readText(path: string): Promise<string | null>;
  join(...parts: string[]): string;
  /** `base`'e göre çözülmüş mutlak yol. */
  resolve(base: string, target: string): string;
}

export type DiscoveredRepositoryKind = 'repository' | 'submodule';

export type DiscoveredRepository = Readonly<{
  /** Proje klasörüne göre `/` ayraçlı göreli yol (ör. `api`, `packages/web`). */
  relativePath: string;
  /** Mutlak yol (proje klasörünün yazımıyla; symlink çözülmemiş). */
  path: string;
  name: string;
  kind: DiscoveredRepositoryKind;
}>;

export type RepositoryDiscoveryResult = Readonly<{
  root: string;
  /** Proje klasörünün kendisi bir Git deposu (ya da worktree'si) mu. */
  rootIsRepository: boolean;
  repositories: readonly DiscoveredRepository[];
  /** Sınır aşıldığı için bazı depolar listelenmedi. */
  truncated: boolean;
}>;

export type RepositoryDiscoveryOptions = Readonly<{
  limit?: number;
}>;

/** `.gitmodules` metnindeki alt modül yolları (`/` ayraçlı). */
export function parseGitmodulesPaths(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const value = /^\s*path\s*=\s*(.*?)\s*$/.exec(line)?.[1];
    if (value === undefined) return [];
    const normalized = value.replaceAll('"', '').replaceAll('\\', '/').replace(/\/+$/, '');
    return normalized === '' ? [] : [normalized];
  });
}

/** Proje klasörüne göre güvenli göreli depo yolu mu (kaçış, mutlak yol, boş parça yok). */
export function isSafeRelativeRepositoryPath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isScannableName(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules';
}

/** `child`, `root`'un kesin olarak içinde mi (`/` ve `\` ayraçlarını tanır). */
export function isStrictlyWithin(root: string, child: string): boolean {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedChild = child.replaceAll('\\', '/');
  return normalizedChild.startsWith(`${normalizedRoot}/`) && normalizedChild !== normalizedRoot;
}

type Candidate = { path: string; relativePath: string; name: string; isSymlink: boolean };

/**
 * Proje klasörünün kapsadığı depoları bulur. Sonuç göreli yola göre sıralıdır; alt modüller
 * kendilerini içeren deponun hemen ardından gelir.
 */
export async function discoverRepositories(
  fs: RepositoryDiscoveryFs,
  root: string,
  options: RepositoryDiscoveryOptions = {}
): Promise<RepositoryDiscoveryResult> {
  const limit = options.limit ?? MAX_DISCOVERED_REPOSITORIES;
  const rootGit = await fs.statKind(fs.join(root, '.git'));
  const rootIsRepository = rootGit !== null;
  const realRoot = (await fs.realPath(root)) ?? root;

  const childDirectories = async (folder: string) =>
    ((await fs.readDirectory(folder)) ?? [])
      .filter((entry) => entry.kind === 'directory' && isScannableName(entry.name))
      .sort((left, right) => compareStrings(left.name, right.name));

  // Yalnızca kendi geçmişi olan (`.git` dizini) klasörler depo sayılır.
  const ownsHistory = async (folder: string) =>
    (await fs.statKind(fs.join(folder, '.git'))) === 'directory';

  const candidates: Candidate[] = [];
  for (const child of await childDirectories(root)) {
    const childPath = fs.join(root, child.name);
    const gitKind = await fs.statKind(fs.join(childPath, '.git'));
    if (gitKind === 'directory') {
      candidates.push({
        path: childPath,
        relativePath: child.name,
        name: child.name,
        isSymlink: child.isSymlink,
      });
      continue;
    }
    // Başka bir deponun worktree'si ya da alt modülü: o deponundur.
    if (gitKind !== null) continue;
    for (const grandchild of await childDirectories(childPath)) {
      const grandchildPath = fs.join(childPath, grandchild.name);
      if (!(await ownsHistory(grandchildPath))) continue;
      candidates.push({
        path: grandchildPath,
        relativePath: `${child.name}/${grandchild.name}`,
        name: grandchild.name,
        isSymlink: child.isSymlink || grandchild.isSymlink,
      });
    }
  }

  const rootSubmodules = rootIsRepository
    ? new Set(parseGitmodulesPaths((await fs.readText(fs.join(root, '.gitmodules'))) ?? ''))
    : new Set<string>();

  // Aynı depoya hem gerçek adıyla hem symlink ile varılıyorsa gerçek adı kazanır.
  const seen = new Set<string>([realRoot]);
  const accepted = new Map<string, DiscoveredRepository>();
  const ordered = [
    ...candidates.filter((candidate) => !candidate.isSymlink),
    ...candidates.filter((candidate) => candidate.isSymlink),
  ];
  let truncated = false;
  for (const candidate of ordered) {
    const real = await fs.realPath(candidate.path);
    // Proje dışındaki bir depoya giden bağlantı projenin parçası değildir.
    if (real === null || seen.has(real) || !isStrictlyWithin(realRoot, real)) continue;
    if (accepted.size >= limit) {
      truncated = true;
      break;
    }
    seen.add(real);
    accepted.set(candidate.relativePath, {
      relativePath: candidate.relativePath,
      path: candidate.path,
      name: candidate.name,
      kind: rootSubmodules.has(candidate.relativePath) ? 'submodule' : 'repository',
    });
  }

  const repositories = [...accepted.values()].sort(byRelativePath);

  // Alt modüller: kök deponun ve bulunan her deponun başlatılmış alt modülleri.
  const containers: Array<{ path: string; relativePath: string }> = [
    ...(rootIsRepository ? [{ path: root, relativePath: '' }] : []),
    ...repositories.filter((repository) => repository.kind === 'repository'),
  ];
  const submodulesByParent = new Map<string, DiscoveredRepository[]>();
  for (const container of containers) {
    if (truncated) break;
    const text = await fs.readText(fs.join(container.path, '.gitmodules'));
    if (!text) continue;
    const realContainer = (await fs.realPath(container.path)) ?? container.path;
    for (const submodulePath of new Set(parseGitmodulesPaths(text))) {
      if (!isSafeRelativeRepositoryPath(submodulePath)) continue;
      const relativePath = container.relativePath
        ? `${container.relativePath}/${submodulePath}`
        : submodulePath;
      if (accepted.has(relativePath)) continue;
      const absolute = fs.join(container.path, ...submodulePath.split('/'));
      // Başlatılmamış alt modül boş bir klasördür.
      if ((await fs.statKind(fs.join(absolute, '.git'))) === null) continue;
      const real = await fs.realPath(absolute);
      // Commit'lenmiş bir symlink alt modülü deponun dışına taşıyamaz.
      if (real === null || seen.has(real) || !isStrictlyWithin(realContainer, real)) continue;
      if (accepted.size >= limit) {
        truncated = true;
        break;
      }
      seen.add(real);
      const submodule: DiscoveredRepository = {
        relativePath,
        path: absolute,
        name: submodulePath.split('/').at(-1) ?? submodulePath,
        kind: 'submodule',
      };
      accepted.set(relativePath, submodule);
      const siblings = submodulesByParent.get(container.relativePath) ?? [];
      siblings.push(submodule);
      submodulesByParent.set(container.relativePath, siblings);
    }
  }

  const result: DiscoveredRepository[] = [
    ...[...(submodulesByParent.get('') ?? [])].sort(byRelativePath),
  ];
  for (const repository of repositories) {
    result.push(repository);
    result.push(
      ...[...(submodulesByParent.get(repository.relativePath) ?? [])].sort(byRelativePath)
    );
  }

  return { root, rootIsRepository, repositories: result, truncated };
}

function byRelativePath(left: DiscoveredRepository, right: DiscoveredRepository): number {
  return compareStrings(left.relativePath, right.relativePath);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type RepositoryRemote = Readonly<{ name: string; url: string }>;

export type RepositoryHeadInfo = Readonly<{
  /** Geçerli dal; ayrık HEAD'de `null`. */
  branch: string | null;
  /** Ayrık HEAD'in kısa SHA'sı. */
  detachedAt: string | null;
  remotes: readonly RepositoryRemote[];
}>;

/** Git config metnindeki `[remote "ad"]` bölümlerinin URL'leri. */
export function parseGitConfigRemotes(text: string): RepositoryRemote[] {
  const remotes: RepositoryRemote[] = [];
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      current = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line)?.[1] ?? null;
      continue;
    }
    if (current === null) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line)?.[1]?.trim();
    if (url && !remotes.some((remote) => remote.name === current)) {
      remotes.push({ name: current, url });
    }
  }
  return remotes;
}

/** `.git` klasörü/dosyası, HEAD ve config dosyalarından dal ve uzak depo bilgisini okur. */
export async function readRepositoryHeadInfo(
  fs: RepositoryDiscoveryFs,
  repositoryPath: string
): Promise<RepositoryHeadInfo> {
  const empty: RepositoryHeadInfo = { branch: null, detachedAt: null, remotes: [] };
  const gitEntry = fs.join(repositoryPath, '.git');
  const gitKind = await fs.statKind(gitEntry);
  let gitDir: string;
  if (gitKind === 'directory') {
    gitDir = gitEntry;
  } else if (gitKind === 'file') {
    const pointer = /^gitdir:\s*(.+)$/m.exec((await fs.readText(gitEntry)) ?? '')?.[1]?.trim();
    if (!pointer) return empty;
    gitDir = fs.resolve(repositoryPath, pointer);
  } else {
    return empty;
  }

  const head = ((await fs.readText(fs.join(gitDir, 'HEAD'))) ?? '').trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  const detachedAt = ref === null && /^[0-9a-f]{7,64}$/i.test(head) ? head.slice(0, 7) : null;

  const commonDirPointer = ((await fs.readText(fs.join(gitDir, 'commondir'))) ?? '').trim();
  const commonDir = commonDirPointer ? fs.resolve(gitDir, commonDirPointer) : gitDir;
  const config = (await fs.readText(fs.join(commonDir, 'config'))) ?? '';

  return { branch: ref, detachedAt, remotes: parseGitConfigRemotes(config) };
}
