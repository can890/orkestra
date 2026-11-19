import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { err, ok, type Result } from '@orkestra/shared';
import { redactSecrets } from '@orkestra/shared/logger';
import {
  isSafeProjectId,
  MEMORY_LIMITS,
  normalizeDescription,
  parseMemoryName,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryError,
  type MemoryLimits,
} from '../api/memory-model';
import { parseMemoryFile, renderMemoryIndex, serializeMemoryFile } from './memory-format';

const INDEX_FILE = 'MEMORY.md';
const MAX_FILE_BYTES_ON_DISK = MEMORY_LIMITS.maxContentBytes + 1024;

export type ProjectMemoryStoreOptions = {
  /** Tüm projelerin hafıza dizinlerinin kökü (userData altında). */
  rootDir: string;
  limits?: Partial<MemoryLimits>;
};

function fail(code: MemoryError['code'], message: string): Result<never, MemoryError> {
  return err({ code, message });
}

/**
 * Proje başına markdown dosyalarından oluşan hafıza deposu. Yol güvenliği: ad katı bir desenle
 * doğrulanır, dosyalar yalnızca proje dizini içinde düz dosya olarak okunur/yazılır ve symlink
 * reddedilir. Yazmalar geçici dosya + rename ile atomiktir; aynı projenin yazmaları sıraya
 * alınır, böylece `MEMORY.md` dizini eşzamanlı yazımlarda bozulmaz.
 */
export class ProjectMemoryStore {
  private readonly rootDir: string;
  private readonly limits: MemoryLimits;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: ProjectMemoryStoreOptions) {
    this.rootDir = options.rootDir;
    this.limits = { ...MEMORY_LIMITS, ...options.limits };
  }

  get maxIndexChars(): number {
    return this.limits.maxIndexChars;
  }

  async list(projectId: string): Promise<Result<MemoryEntrySummary[], MemoryError>> {
    const dir = await this.projectDir(projectId, false);
    if (!dir.success) return dir;
    if (!dir.data) return ok([]);
    return ok(await this.scan(dir.data));
  }

  async read(projectId: string, rawName: string): Promise<Result<MemoryEntry, MemoryError>> {
    const name = parseMemoryName(rawName);
    if (!name.ok) return err(name.error);
    const dir = await this.projectDir(projectId, false);
    if (!dir.success) return dir;
    if (!dir.data) return fail('not-found', `No memory named "${name.name}".`);
    const entry = await this.readEntry(dir.data, name.name);
    return entry ? ok(entry) : fail('not-found', `No memory named "${name.name}".`);
  }

  async write(
    projectId: string,
    input: { name: string; description: string; content: string }
  ): Promise<Result<MemoryEntrySummary, MemoryError>> {
    const name = parseMemoryName(input.name);
    if (!name.ok) return err(name.error);
    const description = normalizeDescription(input.description, this.limits.maxDescriptionChars);
    if (!description) {
      return fail(
        'invalid-description',
        `A one-line description of at most ${this.limits.maxDescriptionChars} characters is required.`
      );
    }
    if (typeof input.content !== 'string' || input.content.includes('\0')) {
      return fail('invalid-content', 'Content must be text without NUL characters.');
    }
    const size = Buffer.byteLength(input.content, 'utf8');
    if (size > this.limits.maxContentBytes) {
      return fail(
        'too-large',
        `Content is ${size} bytes; the limit is ${this.limits.maxContentBytes} bytes per memory.`
      );
    }
    if (
      redactSecrets(input.content) !== input.content ||
      redactSecrets(description) !== description
    ) {
      return fail(
        'secret-detected',
        'The memory looks like it contains a secret (password, token, API key or private key). Remove it and write only non-sensitive notes.'
      );
    }
    const dir = await this.projectDir(projectId, true);
    if (!dir.success) return dir;
    const projectPath = dir.data;
    if (!projectPath) return fail('unsafe-path', 'Project memory directory is unavailable.');

    return this.enqueue(projectId, async () => {
      const existing = await this.scan(projectPath);
      const isUpdate = existing.some((entry) => entry.name === name.name);
      if (!isUpdate && existing.length >= this.limits.maxEntries) {
        return fail(
          'too-many-entries',
          `This project already has ${existing.length} memories (limit ${this.limits.maxEntries}). Delete some first.`
        );
      }
      const target = join(projectPath, `${name.name}.md`);
      const current = await lstat(target).catch(() => null);
      if (current && !current.isFile()) {
        return fail('unsafe-path', 'The memory path is not a regular file.');
      }
      await atomicWrite(target, serializeMemoryFile(description, input.content));
      const entries = await this.scan(projectPath);
      await atomicWrite(join(projectPath, INDEX_FILE), renderMemoryIndex(entries));
      const saved = entries.find((entry) => entry.name === name.name);
      return saved ? ok(saved) : fail('not-found', 'The memory could not be saved.');
    });
  }

  async remove(projectId: string, rawName: string): Promise<Result<void, MemoryError>> {
    const name = parseMemoryName(rawName);
    if (!name.ok) return err(name.error);
    const dir = await this.projectDir(projectId, false);
    if (!dir.success) return dir;
    const projectPath = dir.data;
    if (!projectPath) return fail('not-found', `No memory named "${name.name}".`);
    return this.enqueue(projectId, async () => {
      const target = join(projectPath, `${name.name}.md`);
      const stat = await lstat(target).catch(() => null);
      if (!stat) return fail('not-found', `No memory named "${name.name}".`);
      if (!stat.isFile()) return fail('unsafe-path', 'The memory path is not a regular file.');
      await rm(target);
      await atomicWrite(
        join(projectPath, INDEX_FILE),
        renderMemoryIndex(await this.scan(projectPath))
      );
      return ok(undefined);
    });
  }

  /** Projenin tüm hafızasını siler (proje silinince). */
  async removeProject(projectId: string): Promise<void> {
    if (!isSafeProjectId(projectId)) return;
    await this.enqueue(projectId, () =>
      rm(join(this.rootDir, projectId), { recursive: true, force: true })
    );
  }

  /**
   * Proje dizininin gerçek yolunu döndürür (gerekirse oluşturur). Kök dışına çıkan ya da symlink
   * olan bir proje dizini reddedilir. `create` yokken dizin yoksa `data` null olur.
   */
  private async projectDir(
    projectId: string,
    create: boolean
  ): Promise<Result<string | null, MemoryError>> {
    if (!isSafeProjectId(projectId)) return fail('invalid-project', 'Invalid project id.');
    const path = join(this.rootDir, projectId);
    const stat = await lstat(path).catch(() => null);
    if (!stat) {
      if (!create) return ok(null);
      await mkdir(path, { recursive: true, mode: 0o700 });
    } else if (!stat.isDirectory()) {
      return fail('unsafe-path', 'Project memory path is not a directory.');
    }
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const [realRoot, realDir] = await Promise.all([realpath(this.rootDir), realpath(path)]);
    if (!realDir.startsWith(realRoot + sep)) {
      return fail('unsafe-path', 'Project memory directory is outside the memory root.');
    }
    return ok(realDir);
  }

  private async scan(projectPath: string): Promise<MemoryEntrySummary[]> {
    const names = await readdir(projectPath).catch(() => [] as string[]);
    const entries: MemoryEntrySummary[] = [];
    for (const file of names) {
      if (!file.endsWith('.md')) continue;
      const parsed = parseMemoryName(file);
      // Desene uymayan dosyalar (elle eklenenler, MEMORY.md) listelenmez.
      if (!parsed.ok || `${parsed.name}.md` !== file) continue;
      const entry = await this.readEntry(projectPath, parsed.name);
      if (entry) {
        entries.push({
          name: entry.name,
          description: entry.description,
          size: entry.size,
          updatedAt: entry.updatedAt,
        });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async readEntry(projectPath: string, name: string): Promise<MemoryEntry | null> {
    const path = join(projectPath, `${name}.md`);
    const stat = await lstat(path).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES_ON_DISK) return null;
    const handle = await open(path, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const raw = await handle.readFile('utf8');
      const parsed = parseMemoryFile(raw);
      return {
        name,
        description: parsed.description,
        content: parsed.content,
        size: Buffer.byteLength(parsed.content, 'utf8'),
        updatedAt: Math.round(stat.mtimeMs),
      };
    } finally {
      await handle.close();
    }
  }

  /** Aynı projenin yazmalarını sırayla çalıştırır. */
  private enqueue<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.queues.set(projectId, tail);
    void tail.then(() => {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    });
    return next;
  }
}

async function atomicWrite(target: string, data: string): Promise<void> {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
