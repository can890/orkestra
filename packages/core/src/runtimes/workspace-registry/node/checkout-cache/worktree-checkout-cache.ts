// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/vcs/worktreeCheckoutCache.ts
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CheckoutCloner } from './checkout-cloner';
import { indexEntryStat, parseIndex, restatIndex, type IndexEntryStat } from './git-index-stat';

const KEEP_PER_REPOSITORY = 3;
// Önbellekteki bir checkout'u ilerletmek, worktree oluşturulurken değişen dosya başına
// yaklaşık 0,1 ms tutar; onu yeniden kurmak ise tüm checkout'u yazıp sonra silmek demektir.
const REBUILD_AFTER_CHANGED_FILES = 500;
const UNUSED_REPOSITORY_MS = 30 * 24 * 60 * 60 * 1000;
// Daha eski artıklar bir çökmeden kalmıştır, süren bir işten değil.
const ABANDONED_STAGING_MS = 24 * 60 * 60 * 1000;
const ABANDONED_TRASH_MS = 10 * 60 * 1000;
const STAT_BATCH = 512;
const TREE_ID = /^[0-9a-f]{40}$/u;
// `<tree>-<parmak izi>`: farklı ayarlarla alınmış aynı ağacın checkout'ları birbirinin yerini almaz.
const ENTRY_NAME = /^([0-9a-f]{40})-([0-9a-f]{16})$/u;
const GIT_FALSE = new Set(['false', 'no', 'off', '0']);
const MAX_LIST_BYTES = 256 * 1024 * 1024;
const NULL_OID = '0'.repeat(40);
// 2.42 sistem attributes dosyasını adlandırır (parmak izi buna ihtiyaç duyar); `git hook run` 2.36'dan.
export const MIN_GIT_VERSION = [2, 42] as const;
// Checkout'un yazdığını değiştiren ayarlar. Yeni worktree'de okunur; koşullu include'lar uygulanır.
const CHECKOUT_CONFIG =
  '^(core\\.(autocrlf|eol|symlinks|safecrlf|checkroundtripencoding|precomposeunicode|ignorecase|filemode|attributesfile|sparsecheckout)|filter\\.|lfs\\.|extensions\\.)';
// Önbellek index'lerini stat yeniden yazıcısının okuduğu tek biçimde tutar.
const CACHE_INDEX_CONFIG = [
  'index.version=2',
  'index.skipHash=false',
  'core.splitIndex=false',
  'core.untrackedCache=false',
  'core.fsmonitor=false',
  'core.sparseCheckout=false',
  // Özel kurulumlar deponun hook'larını çalıştırmamalı.
  'core.hooksPath=/dev/null',
  'checkout.workers=0',
].flatMap((setting) => ['-c', setting]);

/** Varsayılan APFS gibi büyük/küçük harf ve normalizasyon duyarsız bir birimin adları karşılaştırması. */
const foldCase = (file: string) => file.normalize('NFC').toLowerCase();

/** `check-attr --all -z` çıktısı: herhangi bir `filter` özniteliği sayılır (`unset` da bir sürücü adlandırabilir). */
export function namesFilter(output: string): boolean {
  const fields = output.split('\0');
  for (let index = 1; index < fields.length; index += 3) {
    if (fields[index] === 'filter') return true;
  }
  return false;
}

/** `paths` içindeki yolları tutan her klasör; kök "" olarak dahildir. */
function parentDirectories(paths: Iterable<string>): Set<string> {
  const directories = new Set(['']);
  for (const entryPath of paths) {
    for (let slash = entryPath.lastIndexOf('/'); slash > 0; ) {
      const directory = entryPath.slice(0, slash);
      if (directories.has(directory)) break;
      directories.add(directory);
      slash = directory.lastIndexOf('/');
    }
  }
  return directories;
}

export function parseGitVersion(output: string | null): readonly [number, number] | null {
  const match = output?.match(/git version (\d+)\.(\d+)/u);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function gitVersionSupported(version: readonly [number, number] | null): boolean {
  if (version === null) return false;
  const [major, minor] = version;
  return (
    major > MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor >= MIN_GIT_VERSION[1])
  );
}

/** Önbelleğin git çağrıları: başarılıysa stdout, sıfır olmayan çıkışta ya da hatada null. */
export type CacheGit = (
  cwd: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; stdin?: string }
) => Promise<string | null>;

/** Varsayılan git çalıştırıcı: etkileşimsiz, C yereli, stdin destekli. */
export function createCacheGit(
  env: () => Promise<NodeJS.ProcessEnv> = async () => process.env
): CacheGit {
  return async (cwd, args, options = {}) => {
    const base = await env();
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn('git', [...args], {
          cwd,
          env: {
            ...base,
            LC_ALL: 'C',
            LANG: 'C',
            LANGUAGE: 'C',
            GIT_TERMINAL_PROMPT: '0',
            ...options.env,
          },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let overflow = false;
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_LIST_BYTES) {
          overflow = true;
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        resolve(code === 0 && !overflow ? Buffer.concat(chunks).toString('utf8') : null);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdin ?? '');
    });
  };
}

type CacheEntry = {
  readonly directory: string;
  readonly tree: string;
  readonly fingerprint: string;
  readonly mtimeMs: number;
};

type Described = {
  commonDir: string;
  commit: string;
  tree: string;
  indexHook: string;
  bucket: string;
};

type Changes = {
  count: number;
  attributes: boolean;
  added: string[];
  deleted: string[];
  written: string[];
};

export type WorktreeCheckoutCacheOptions = {
  /** Önbelleğin kök klasörü (ör. `<veri dizini>/worktree-checkout-cache`). */
  cacheDir: string;
  /** Platformun klasör klonlayıcısı; undefined ise önbellek devre dışıdır. */
  cloner: CheckoutCloner | undefined;
  git?: CacheGit;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Bir yolun bulunduğu birim (aygıt) kimliği; testler farklı birimi taklit eder. */
  deviceOf?: (target: string) => Promise<number | null>;
  logger?: {
    info?(message: string, context?: Record<string, unknown>): void;
    warn?(message: string, context?: Record<string, unknown>): void;
  };
};

export type CreateFromCacheInput = {
  /** Deponun yolu (`git worktree add` buradan çalışır). */
  cwd: string;
  worktreePath: string;
  /** Checkout edilecek revizyon: mevcut dal ya da yeni dalın tabanı. */
  refName: string;
  /** Verilirse `--no-track -b <newBranch>` ile `refName`'den yeni dal açılır. */
  newBranch?: string;
};

/**
 * Özel, Git tarafından yazılmış bir checkout'u APFS copy-on-write ile klonlar, ardından
 * index'in stat verisini yeniden yazar; böylece Git klonlara yeniden okumadan güvenir.
 * Önbellekteki daha eski bir checkout `read-tree -m -u` ile istenen ağaca taşınır.
 */
export class WorktreeCheckoutCache {
  readonly cacheDir: string;
  private readonly clone: CheckoutCloner | undefined;
  private readonly git: CacheGit;
  private readonly homeDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly deviceOf: (target: string) => Promise<number | null>;
  private readonly logger: NonNullable<WorktreeCheckoutCacheOptions['logger']>;
  private buildChain: Promise<void> = Promise.resolve();
  private readonly pendingBuilds = new Set<string>();
  /** `clear` ile artar; ondan önce başlamış bir kurulum sonucunu yayımlamaz. */
  private generation = 0;
  private gitSupportedPromise: Promise<boolean> | null = null;
  private systemAttributesPromise: Promise<string[]> | null = null;

  constructor(options: WorktreeCheckoutCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.clone = options.cloner;
    this.git = options.git ?? createCacheGit();
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.deviceOf =
      options.deviceOf ??
      (async (target) => {
        const info = await fs.stat(target).catch(() => null);
        return info?.dev ?? null;
      });
    this.logger = options.logger ?? {};
  }

  /** Platform klasör klonlamayı destekliyor mu (macOS). */
  get supported(): boolean {
    return this.clone !== undefined;
  }

  /** Bir checkout başlamadan önce `schedule`'a verilecek kuşak değeri. */
  currentGeneration(): number {
    return this.generation;
  }

  private gitSupported(): Promise<boolean> {
    this.gitSupportedPromise ??= this.git(this.homeDirectory, ['version']).then((stdout) =>
      gitVersionSupported(parseGitVersion(stdout))
    );
    return this.gitSupportedPromise;
  }

  private async describe(cwd: string, rev: string): Promise<Described | null> {
    const stdout = await this.git(cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--show-object-format',
      '--git-path',
      'hooks/post-index-change',
      `${rev}^{commit}`,
      `${rev}^{tree}`,
    ]);
    const [commonDir, objectFormat, indexHook, commit, tree] = stdout?.trim().split('\n') ?? [];
    if (
      !commonDir ||
      objectFormat !== 'sha1' ||
      !indexHook ||
      !commit ||
      !tree ||
      !TREE_ID.test(tree)
    ) {
      return null;
    }
    const realCommonDir = await fs.realpath(commonDir).catch(() => commonDir);
    const repositoryKey = createHash('sha256').update(realCommonDir).digest('hex').slice(0, 16);
    return {
      commonDir,
      commit,
      tree,
      indexHook: path.resolve(cwd, indexHook),
      bucket: path.join(this.cacheDir, repositoryKey),
    };
  }

  /** `GIT_ATTR_NOSYSTEM` sistem attributes dosyasını kapattığında boş. */
  private systemAttributePaths(): Promise<string[]> {
    this.systemAttributesPromise ??= this.git(this.homeDirectory, ['var', 'GIT_ATTR_SYSTEM']).then(
      (stdout) => (stdout?.trim() ? [stdout.trim()] : [])
    );
    return this.systemAttributesPromise;
  }

  /** Önbelleğin yeniden üretemeyeceği kurulumlarda (ör. sparse checkout) null. */
  async fingerprint(cwd: string, commonDir: string): Promise<string | null> {
    const config =
      (await this.git(cwd, ['config', '--null', '--get-regexp', CHECKOUT_CONFIG])) ?? '';
    const pairs = config
      .split('\0')
      .filter(Boolean)
      .map((pair) => {
        const newline = pair.indexOf('\n');
        return newline < 0
          ? ([pair, ''] as const)
          : ([pair.slice(0, newline), pair.slice(newline + 1)] as const);
      });
    const lastValue = (name: string) => {
      for (let index = pairs.length - 1; index >= 0; index--) {
        if (pairs[index]![0] === name) return pairs[index]![1];
      }
      return undefined;
    };
    const sparse = lastValue('core.sparsecheckout');
    if (sparse !== undefined && !GIT_FALSE.has(sparse.toLowerCase())) return null;
    const attributesFile = lastValue('core.attributesfile')?.replace(
      /^~(?=$|\/)/u,
      this.homeDirectory
    );
    // Git göreli bir yolu her checkout'tan okur; önbellek ile worktree'de farklıdır.
    if (attributesFile !== undefined && !path.isAbsolute(attributesFile)) return null;
    const attributePaths = [
      ...(await this.systemAttributePaths()),
      path.join(commonDir, 'info', 'attributes'),
      attributesFile ??
        path.join(
          this.environment.XDG_CONFIG_HOME || path.join(this.homeDirectory, '.config'),
          'git',
          'attributes'
        ),
    ];
    const attributes = await Promise.all(
      attributePaths.map((file) => fs.readFile(file, 'utf8').catch(() => ''))
    );
    const hash = createHash('sha256').update(config);
    for (const contents of attributes) hash.update('\0').update(contents);
    return hash.digest('hex').slice(0, 16);
  }

  private async listEntries(bucket: string): Promise<CacheEntry[]> {
    const names = await fs.readdir(bucket).catch(() => [] as string[]);
    const entries = await Promise.all(
      names.map(async (name): Promise<CacheEntry | null> => {
        const match = ENTRY_NAME.exec(name);
        if (!match) return null;
        const directory = path.join(bucket, name);
        const info = await fs.stat(directory).catch(() => null);
        if (!info) return null;
        return { directory, tree: match[1]!, fingerprint: match[2]!, mtimeMs: info.mtimeMs };
      })
    );
    return entries
      .filter((entry): entry is CacheEntry => entry !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  private async touch(target: string): Promise<void> {
    const seconds = this.now() / 1000;
    await fs.utimes(target, seconds, seconds).catch(() => undefined);
  }

  private async statEntries(
    root: string,
    paths: readonly string[]
  ): Promise<Array<IndexEntryStat | undefined>> {
    const stats: Array<IndexEntryStat | undefined> = [];
    for (let start = 0; start < paths.length; start += STAT_BATCH) {
      const batch = await Promise.all(
        paths.slice(start, start + STAT_BATCH).map((entryPath) =>
          fs.lstat(`${root}/${entryPath}`, { bigint: true }).then(indexEntryStat, (error) => {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
            throw error;
          })
        )
      );
      stats.push(...batch);
    }
    return stats;
  }

  /**
   * `source` index'inden, `root` altındaki dosyaların stat verisiyle `target`'ı yazar ve
   * okuduğunu döner. Index ya da dosyalara güvenilemiyorsa null.
   */
  private async restate(input: {
    source: string;
    target: string;
    root: string;
    verify: boolean;
  }): Promise<{ paths: string[]; stats: Array<IndexEntryStat | undefined> } | null> {
    const parsed = parseIndex(new Uint8Array(await fs.readFile(input.source)));
    if (parsed === null) return null;
    const paths = parsed.entries.map((entry) => entry.path);
    const stats = await this.statEntries(input.root, paths);
    const restated = restatIndex(parsed, stats, { verify: input.verify });
    if (restated === null) return null;
    const temporary = `${input.target}.orkestra-${randomUUID()}`;
    await fs.writeFile(temporary, restated);
    await fs.rename(temporary, input.target);
    return { paths, stats };
  }

  private async directoryTimes(root: string, directories: readonly string[]): Promise<string[]> {
    return await Promise.all(
      directories.map((directory) =>
        fs.lstat(directory === '' ? root : `${root}/${directory}`, { bigint: true }).then(
          (stat) => String(stat.mtimeNs),
          () => 'missing'
        )
      )
    );
  }

  /** Bir dosya eklemek ya da silmek klasörün mtime'ını değiştirir; index'te olmayan dosyaları yakalar. */
  private async recordDirectories(
    entryDirectory: string,
    recorded: { paths: readonly string[]; stats: ReadonlyArray<IndexEntryStat | undefined> }
  ): Promise<void> {
    const directories = parentDirectories(recorded.paths);
    for (const [index, entryPath] of recorded.paths.entries()) {
      if (recorded.stats[index]?.kind === 'directory') directories.add(entryPath);
    }
    // Adları yalnız büyük/küçük harfte ayrılan klasörler diskte tek yazımı paylaşır.
    const folded = new Set([...directories].map((directory) => foldCase(directory)));
    if (folded.size !== directories.size) {
      throw new Error('folder names differ only in case');
    }
    const list = [...directories];
    // Geriye tarihlenir; kaba saatli bir dosya sisteminde bile sonraki değişiklik zamanı oynatır.
    const root = path.join(entryDirectory, 'files');
    await Promise.all(
      list.map((directory) =>
        fs.utimes(directory === '' ? root : `${root}/${directory}`, 1_000_000, 1_000_000)
      )
    );
    const times = await this.directoryTimes(root, list);
    await fs.writeFile(
      path.join(entryDirectory, 'directories'),
      list.map((directory, index) => `${times[index]}\0${directory}\0`).join('')
    );
  }

  private async directoriesUnchanged(entry: CacheEntry): Promise<boolean> {
    try {
      const recorded = (await fs.readFile(path.join(entry.directory, 'directories'), 'utf8'))
        .split('\0')
        .slice(0, -1);
      const times = recorded.filter((_, index) => index % 2 === 0);
      const directories = recorded.filter((_, index) => index % 2 === 1);
      const current = await this.directoryTimes(path.join(entry.directory, 'files'), directories);
      return directories.length > 0 && current.every((time, index) => time === times[index]);
    } catch {
      return false;
    }
  }

  private async changedPaths(cwd: string, from: string, to: string): Promise<Changes | null> {
    const stdout = await this.git(cwd, [
      'diff-tree',
      '-r',
      '-z',
      '--name-status',
      '--no-renames',
      from,
      to,
    ]);
    if (stdout === null) return null;
    const fields = stdout.split('\0');
    const added: string[] = [];
    const deleted: string[] = [];
    // Eklenen ya da değişen: `read-tree -m -u`'nun kendisinin yazdıkları.
    const written: string[] = [];
    let count = 0;
    let attributes = false;
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index]!;
      const file = fields[index + 1]!;
      count++;
      // `read-tree -m -u` öznitelikleri değişse bile değişmeyen dosyalara dokunmaz.
      if (file === '.gitattributes' || file.endsWith('/.gitattributes')) attributes = true;
      if (status === 'A') added.push(file);
      if (status === 'D') deleted.push(file);
      else written.push(file);
    }
    return { count, attributes, added, deleted, written };
  }

  /** Bir smudge filtresinin çıktısı ortama ve ağa bağlı olabilir (Git LFS gibi). */
  private async usesFilter(cwd: string, bucket: string, tree: string): Promise<boolean> {
    // Ağacın bir index'i `check-attr`'ın onun `.gitattributes`'larını okumasını sağlar.
    const index = path.join(bucket, `.attributes-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if ((await this.git(cwd, [...CACHE_INDEX_CONFIG, 'read-tree', tree], { env })) === null) {
        return true;
      }
      const files = await this.git(cwd, ['ls-files', '-z'], { env });
      if (files === null) return true;
      const output = await this.git(cwd, ['check-attr', '--cached', '--all', '-z', '--stdin'], {
        env,
        stdin: files,
      });
      return output === null || namesFilter(output);
    } catch {
      return true;
    } finally {
      await fs.rm(index, { force: true }).catch(() => undefined);
    }
  }

  /** Öznitelikler, taşımanın değiştirmediği klonlanmış `.gitattributes` dosyalarından gelir. */
  private async writesWithFilter(cwd: string, files: readonly string[]): Promise<boolean> {
    if (files.length === 0) return false;
    const output = await this.git(cwd, ['check-attr', '--all', '-z', '--stdin'], {
      stdin: files.map((file) => `${file}\0`).join(''),
    });
    return output === null || namesFilter(output);
  }

  /** Önce yeniden adlandırılır; böylece hiçbir şey yarı silinmiş bir checkout'u klonlamaz. */
  private async discard(target: string): Promise<void> {
    const trashed = `${target}.trash-${randomUUID()}`;
    try {
      await fs.rename(target, trashed);
      await fs.rm(trashed, { recursive: true, force: true });
    } catch {
      // Silinemeyen artıklar bir sonraki kurulumda terk edilmiş olarak temizlenir.
    }
  }

  private async gitDirOf(worktreePath: string): Promise<string> {
    const contents = await fs.readFile(path.join(worktreePath, '.git'), 'utf8');
    const gitDir = contents.match(/^gitdir: (.+)$/mu)?.[1];
    if (gitDir === undefined) throw new Error(`${worktreePath} is not a linked worktree`);
    return path.resolve(worktreePath, gitDir.trim());
  }

  private async exists(target: string): Promise<boolean> {
    return await fs.lstat(target).then(
      () => true,
      () => false
    );
  }

  /**
   * Worktree'yi önbellekten oluşturur. False hiçbir şeyin oluşturulmadığı ve çağıranın
   * normal `git worktree add` çalıştırması gerektiği anlamına gelir; olası yarım worktree
   * geri alınmıştır (oluşturulan dal dahil).
   */
  async create(input: CreateFromCacheInput): Promise<boolean> {
    if (this.clone === undefined) return false;
    if (!(await this.gitSupported())) return false;
    const worktreePath = path.resolve(input.cwd, input.worktreePath);
    const requested = await this.describe(input.cwd, input.refName);
    if (requested === null) return false;
    const entries = await this.listEntries(requested.bucket);
    if (entries.length === 0) return false;
    // Klon yalnızca tek bir birim içinde çalışır.
    const parent = path.dirname(worktreePath);
    await fs.mkdir(parent, { recursive: true }).catch(() => undefined);
    const [bucketDevice, parentDevice] = await Promise.all([
      this.deviceOf(requested.bucket),
      this.deviceOf(parent),
    ]);
    if (bucketDevice === null || parentDevice === null || bucketDevice !== parentDevice) {
      return false;
    }

    const registered = await this.git(input.cwd, [
      'worktree',
      'add',
      '--no-checkout',
      ...(input.newBranch ? ['--no-track', '-b', input.newBranch] : []),
      '--',
      worktreePath,
      input.refName,
    ]);
    if (registered === null) return false;

    let target: Described | null = null;
    try {
      target = await this.populate(worktreePath, entries);
    } catch (error) {
      this.logger.warn?.('worktree checkout cache failed; using git worktree add', {
        error: error instanceof Error ? error.message : String(error),
      });
      target = null;
    }
    if (target !== null) {
      // `git worktree add --no-checkout` bu hook'u atlar; normal bir add onu çalıştırır.
      const hook = await this.git(worktreePath, [
        'hook',
        'run',
        '--ignore-missing',
        'post-checkout',
        '--',
        NULL_OID,
        target.commit,
        '1',
      ]);
      if (hook !== null) return true;
      this.logger.warn?.('post-checkout hook failed after a cached checkout; falling back');
    }
    await this.rollback(input, worktreePath, input.newBranch ?? null);
    return false;
  }

  private async rollback(
    input: CreateFromCacheInput,
    worktreePath: string,
    createdBranch: string | null
  ): Promise<void> {
    const removed = await this.git(input.cwd, [
      'worktree',
      'remove',
      '--force',
      '--',
      worktreePath,
    ]);
    if (removed === null) {
      this.logger.warn?.('could not remove a partially created worktree', { worktreePath });
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await this.git(input.cwd, ['worktree', 'prune']);
    }
    if (createdBranch) await this.git(input.cwd, ['branch', '-D', '--', createdBranch]);
  }

  private async populate(
    worktreePath: string,
    entries: readonly CacheEntry[]
  ): Promise<Described | null> {
    const clone = this.clone;
    if (clone === undefined) return null;
    // Git'in gerçekte checkout ettiği; bir etiket dalla aynı adı taşıyorsa `requested`'dan farklı olabilir.
    const target = await this.describe(worktreePath, 'HEAD');
    if (target === null || (await this.exists(target.indexHook))) return null;
    const worktreeFingerprint = await this.fingerprint(worktreePath, target.commonDir);
    if (worktreeFingerprint === null) return null;
    const compatible = entries.filter((entry) => entry.fingerprint === worktreeFingerprint);
    let base = compatible.find((entry) => entry.tree === target.tree);
    let changes: Changes | null = null;
    for (const entry of base === undefined ? compatible : []) {
      changes = await this.changedPaths(worktreePath, entry.tree, target.tree);
      if (changes !== null && !changes.attributes) {
        base = entry;
        break;
      }
    }
    if (base === undefined) return null;
    const chosen = base;
    // Önbellekteki bir dosya Git yazdıktan sonra değişti; bir daha asla dağıtma.
    const reject = async () => {
      this.logger.warn?.('worktree checkout cache entry changed; discarding it', {
        directory: chosen.directory,
      });
      await this.discard(chosen.directory);
      return null;
    };
    if (!(await this.directoriesUnchanged(chosen))) return await reject();
    await Promise.all([this.touch(chosen.directory), this.touch(path.dirname(chosen.directory))]);

    const files = path.join(chosen.directory, 'files');
    // Worktree klasöründe zaten Git'in `.git` dosyası var; girdiler tek tek klonlanır.
    const names = await fs.readdir(files);
    const cloned = await clone(
      names.map((name) => ({
        source: path.join(files, name),
        destination: path.join(worktreePath, name),
      }))
    );
    if (!cloned) return null;
    // Yeniden kontrol: klon sırasında eklenen bir dosya fark edilmeden gelirdi.
    if (!(await this.directoriesUnchanged(chosen))) return await reject();
    // İzlenen bir hooks klasörü ancak dosyalar gelince var olur; Git bu hook'u çalıştırırdı.
    if (await this.exists(target.indexHook)) return null;
    const restated = await this.restate({
      source: path.join(chosen.directory, 'index'),
      target: path.join(await this.gitDirOf(worktreePath), 'index'),
      root: worktreePath,
      verify: true,
    });
    if (restated === null) return await reject();
    if (chosen.tree === target.tree || changes === null) return target;
    // Büyük/küçük harf duyarsız bir birimde eklenen bir yol önbellek ağacının tuttuğu bir dosyaya düşebilir.
    const deleted = new Set(changes.deleted);
    const kept = restated.paths.filter((file) => !deleted.has(file));
    const keptNames = new Set(kept.map((file) => foldCase(file)));
    // Adı yalnız büyük/küçük harfte ayrılan yeni bir klasör önbellekteki yazımı korurdu.
    const keptFolders = parentDirectories(kept);
    for (const [index, file] of restated.paths.entries()) {
      if (restated.stats[index]?.kind === 'directory' && !deleted.has(file)) keptFolders.add(file);
    }
    const spellings = new Map(
      [...keptFolders].map((directory) => [foldCase(directory), directory])
    );
    for (const file of changes.added) {
      if (keptNames.has(foldCase(file))) return null;
      keptNames.add(foldCase(file));
      for (const directory of parentDirectories([file])) {
        const existing = spellings.get(foldCase(directory));
        if (existing !== undefined && existing !== directory) return null;
        spellings.set(foldCase(directory), directory);
      }
    }
    // Burada çalışan bir smudge filtresi Git'in sıfırdan kurduğu değil, önbellekteki index'i görürdü.
    if (await this.writesWithFilter(worktreePath, changes.written)) return null;
    // Hook'lar kapalı: taşımanın eklediği bir hook sonrasında varsa çağıran normal checkout'a döner.
    const moved = await this.git(worktreePath, [
      '-c',
      'core.hooksPath=/dev/null',
      'read-tree',
      '-m',
      '-u',
      chosen.tree,
      target.tree,
    ]);
    if (moved === null || (await this.exists(target.indexHook))) return null;
    return target;
  }

  private async removeIfAbandoned(target: string, maxAgeMs: number): Promise<void> {
    try {
      const info = await fs.stat(target);
      if (this.now() - info.mtimeMs > maxAgeMs) {
        await fs.rm(target, { recursive: true, force: true });
      }
    } catch {
      // Yarış ya da izin sorunu: sonraki kurulum yeniden dener.
    }
  }

  /** `worktreePath`'te checkout edilmiş ağacı önbelleğe alır; yakın bir önbellek girdisi yoksa. */
  async build(worktreePath: string, generationAtStart: number): Promise<void> {
    if (this.clone === undefined) return;
    const clone = this.clone;
    if (!(await this.gitSupported())) return;
    const target = await this.describe(worktreePath, 'HEAD');
    if (target === null) return;
    const entryFingerprint = await this.fingerprint(worktreePath, target.commonDir);
    if (entryFingerprint === null) return;
    const entryName = `${target.tree}-${entryFingerprint}`;
    await fs.mkdir(target.bucket, { recursive: true });
    const entries = await this.listEntries(target.bucket);
    const compatible = entries.filter((entry) => entry.fingerprint === entryFingerprint);
    if (compatible.some((entry) => entry.tree === target.tree)) return;
    // Önbellekteki bir checkout ucuzca ilerletilebilecek kadar yakınsa atla.
    let base: CacheEntry | undefined;
    for (const entry of compatible) {
      const changes = await this.changedPaths(worktreePath, entry.tree, target.tree);
      if (changes === null || changes.attributes) continue;
      if (changes.count < REBUILD_AFTER_CHANGED_FILES) return;
      base ??= entry;
    }
    if (await this.usesFilter(worktreePath, target.bucket, target.tree)) return;

    for (const name of await fs.readdir(target.bucket)) {
      if (!ENTRY_NAME.test(name)) {
        await this.removeIfAbandoned(
          path.join(target.bucket, name),
          name.includes('.trash-') ? ABANDONED_TRASH_MS : ABANDONED_STAGING_MS
        );
      }
    }
    const staging = path.join(target.bucket, `.staging-${randomUUID()}`);
    const stagingFiles = path.join(staging, 'files');
    const stagingIndex = path.join(staging, 'index');
    await fs.mkdir(staging);
    const withIndex = (args: readonly string[]) =>
      this.git(worktreePath, [...CACHE_INDEX_CONFIG, `--work-tree=${stagingFiles}`, ...args], {
        env: { GIT_INDEX_FILE: stagingIndex },
      });

    try {
      let built = false;
      if (base !== undefined && (await this.directoriesUnchanged(base))) {
        const from = base;
        try {
          built = await (async () => {
            if (
              !(await clone([
                { source: path.join(from.directory, 'files'), destination: stagingFiles },
              ]))
            ) {
              return false;
            }
            if (!(await this.directoriesUnchanged(from))) return false;
            const restated = await this.restate({
              source: path.join(from.directory, 'index'),
              target: stagingIndex,
              root: stagingFiles,
              verify: true,
            });
            if (restated === null) return false;
            return (await withIndex(['read-tree', '-m', '-u', from.tree, target.tree])) !== null;
          })();
        } catch {
          built = false;
        }
        if (!built) {
          await fs.rm(stagingFiles, { recursive: true, force: true }).catch(() => undefined);
          await fs.rm(stagingIndex, { force: true }).catch(() => undefined);
        }
      }
      if (!built) {
        await fs.mkdir(stagingFiles);
        if ((await withIndex(['read-tree', '--reset', '-u', target.tree])) === null) {
          throw new Error('git read-tree failed');
        }
      }
      // Dosyaların kendi stat verisini kaydet; Git yarışlı yazılmış girdileri sonraki okumaya bırakır.
      const recorded = await this.restate({
        source: stagingIndex,
        target: stagingIndex,
        root: stagingFiles,
        verify: false,
      });
      if (recorded === null) {
        throw new Error('the cache index has an unsupported format or colliding paths');
      }
      await this.recordDirectories(staging, recorded);
      if (this.generation !== generationAtStart) throw new Error('the cache was cleared');
      await fs.rename(staging, path.join(target.bucket, entryName));
    } catch (error) {
      await this.discard(staging);
      throw error;
    }

    await this.touch(target.bucket);
    for (const entry of (await this.listEntries(target.bucket)).slice(KEEP_PER_REPOSITORY)) {
      await this.discard(entry.directory);
    }
    const now = this.now();
    for (const name of await fs.readdir(this.cacheDir).catch(() => [] as string[])) {
      const bucket = path.join(this.cacheDir, name);
      if (bucket === target.bucket) continue;
      if (name.includes('.trash-')) {
        await this.removeIfAbandoned(bucket, ABANDONED_TRASH_MS);
        continue;
      }
      const info = await fs.stat(bucket).catch(() => null);
      if (info && now - info.mtimeMs > UNUSED_REPOSITORY_MS) await this.discard(bucket);
    }
  }

  /** Worktree'nin checkout'unu arka planda önbelleğe alır; sonraki worktree onu klonlayabilir. */
  schedule(worktreePath: string, generationAtStart: number): Promise<void> {
    if (this.clone === undefined || this.pendingBuilds.has(worktreePath)) {
      return this.buildChain;
    }
    this.pendingBuilds.add(worktreePath);
    this.buildChain = this.buildChain
      .then(() => this.build(worktreePath, generationAtStart))
      .catch((error: unknown) => {
        this.logger.warn?.('worktree checkout cache build failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pendingBuilds.delete(worktreePath);
      });
    return this.buildChain;
  }

  /** Sıradaki tüm arka plan kurulumları bitince çözülür. */
  whenIdle(): Promise<void> {
    return this.buildChain;
  }

  /** Önbellekteki her checkout'u siler; o sırada süren kurulumlar sonucu yayımlamaz. */
  clear(): Promise<void> {
    this.generation++;
    this.buildChain = this.buildChain.then(async () => {
      if (await this.exists(this.cacheDir)) await this.discard(this.cacheDir);
    });
    return this.buildChain;
  }
}
