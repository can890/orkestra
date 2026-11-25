/**
 * Bağlam devri döküm dosyalarının (`~/.orkestra/handoffs/<halef sohbet kimliği>.md`) saklama
 * kuralı. Dosyalar devir anında, ajanın çalıştığı ana makinede (yerel ya da SSH) yazılır;
 * kendiliğinden silinmezlerse sınırsız birikir.
 *
 * Kural (`selectTranscriptsToPrune`, saf):
 * - Yalnızca bizim adlandırdığımız dosyalar (`<kimlik>.md`) adaydır; klasördeki başka hiçbir şeye
 *   dokunulmaz, alt klasörlere inilmez.
 * - `minAgeMs`'ten (7 gün) genç dosya hiç silinmez.
 * - Halef sohbeti hâlâ duran ve son `recentUseMs` (30 gün) içinde kullanılmış dosya hiç silinmez:
 *   ajan belirsizlikte dökümü okumaya yönlendirilmiştir.
 * - Kalanlardan `maxAgeMs`'ten (30 gün) eski olanlar ve en yeni `keepNewest` (50) dışında kalanlar
 *   silinir.
 *
 * Çalıştırma fırsatçıdır: her başarılı bağlam devrinden sonra o ana makine için istenir, ana
 * makine başına en fazla `throttleMs`'te (6 saat) bir yapılır (`TranscriptRetentionScheduler`).
 * Dosyalar yalnızca devirle çoğaldığı için bu, birikmeyi sınırlamaya yeter.
 */
import { filesContract } from '@orkestra/core/runtimes/files/api';
import type { HostRuntimesClient } from '@orkestra/core/services/runtime-broker/api';
import { and, inArray, isNull } from 'drizzle-orm';
import { contextHandoffTranscriptDir } from '@core/features/conversations/api/context-handoff-package';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import {
  fileKeyForAbsolutePath,
  hostPathFromNative,
  joinHostPath,
  nativePathFromHost,
} from '@core/primitives/desktop-runtime/api/paths';
import type { AppDb } from '@core/services/app-db/node/db';
import { runRuntimeLiveJob } from '@core/services/runtime-clients/node/live-job';

const DAY_MS = 24 * 60 * 60 * 1000;

export type TranscriptRetentionPolicy = {
  maxAgeMs: number;
  keepNewest: number;
  minAgeMs: number;
  recentUseMs: number;
};

export const TRANSCRIPT_RETENTION_POLICY: TranscriptRetentionPolicy = {
  maxAgeMs: 30 * DAY_MS,
  keepNewest: 50,
  minAgeMs: 7 * DAY_MS,
  recentUseMs: 30 * DAY_MS,
};

/** Aynı ana makinede iki temizlik arasındaki en kısa süre. */
export const TRANSCRIPT_RETENTION_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** Bizim yazdığımız döküm adları: `<sohbet kimliği>.md` (kimlik UUID ya da benzeri). */
const TRANSCRIPT_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{7,127})\.md$/;

export type TranscriptFileEntry = {
  name: string;
  conversationId: string;
  mtimeMs: number;
};

/** Dosya adı bir devir dökümü mü; öyleyse halef sohbet kimliği. */
export function transcriptConversationId(name: string): string | null {
  return TRANSCRIPT_FILE_RE.exec(name)?.[1] ?? null;
}

/**
 * Silinecek dökümleri seçer. `lastUsedAt`: halef sohbeti kayıt defterinde hâlâ duruyorsa son
 * kullanım zamanı (ms); yoksa kayıt yoktur.
 */
export function selectTranscriptsToPrune(
  entries: readonly TranscriptFileEntry[],
  input: {
    now: number;
    lastUsedAt: ReadonlyMap<string, number>;
    policy?: TranscriptRetentionPolicy;
  }
): TranscriptFileEntry[] {
  const policy = input.policy ?? TRANSCRIPT_RETENTION_POLICY;
  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const prune: TranscriptFileEntry[] = [];
  newestFirst.forEach((entry, rank) => {
    const age = input.now - entry.mtimeMs;
    if (age < policy.minAgeMs) return;
    const usedAt = input.lastUsedAt.get(entry.conversationId);
    if (usedAt !== undefined && input.now - usedAt < policy.recentUseMs) return;
    if (age > policy.maxAgeMs || rank >= policy.keepNewest) prune.push(entry);
  });
  return prune;
}

/** Ana makinenin dosya yüzü (yerel ya da SSH dosya çalışma zamanı). */
export type TranscriptRetentionFiles = {
  homeDir(): Promise<string>;
  /** Klasördeki dosyaların klasöre göre yolları; klasör yoksa `null`. */
  list(dir: string): Promise<string[] | null>;
  mtimeMs(path: string): Promise<number | null>;
  remove(path: string): Promise<boolean>;
};

export type TranscriptRetentionResult = {
  scanned: number;
  deleted: string[];
  failed: string[];
};

export async function pruneContextHandoffTranscripts(deps: {
  files: TranscriptRetentionFiles;
  /** Verilen halef kimliklerinden kayıt defterinde duranların son kullanım zamanları. */
  lastUsedAt(conversationIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  now: number;
  policy?: TranscriptRetentionPolicy;
}): Promise<TranscriptRetentionResult> {
  const result: TranscriptRetentionResult = { scanned: 0, deleted: [], failed: [] };
  const home = (await deps.files.homeDir()).trim();
  if (!home) return result;
  const dir = contextHandoffTranscriptDir(home);
  const listed = await deps.files.list(dir);
  if (!listed) return result;

  const entries: TranscriptFileEntry[] = [];
  for (const relative of listed) {
    // Yalnızca klasörün kendi dosyaları; alt klasörlere dokunulmaz.
    if (relative.includes('/') || relative.includes('\\')) continue;
    const conversationId = transcriptConversationId(relative);
    if (!conversationId) continue;
    const mtimeMs = await deps.files.mtimeMs(joinHostPath(dir, relative));
    if (mtimeMs === null) continue;
    entries.push({ name: relative, conversationId, mtimeMs });
  }
  result.scanned = entries.length;
  if (entries.length === 0) return result;

  const lastUsedAt = await deps.lastUsedAt(entries.map((entry) => entry.conversationId));
  const prune = selectTranscriptsToPrune(entries, {
    now: deps.now,
    lastUsedAt,
    ...(deps.policy ? { policy: deps.policy } : {}),
  });
  for (const entry of prune) {
    const removed = await deps.files.remove(joinHostPath(dir, entry.name)).catch(() => false);
    (removed ? result.deleted : result.failed).push(entry.name);
  }
  return result;
}

/** Dosya çalışma zamanını (yerel ya da SSH) temizliğin dosya yüzüne bağlar. */
export function runtimeTranscriptRetentionFiles(
  files: HostRuntimesClient['files']
): TranscriptRetentionFiles {
  return {
    async homeDir() {
      const home = await files.getHomeDir();
      return nativePathFromHost(home.path);
    },
    async list(dir) {
      const key = fileKeyForAbsolutePath(hostPathFromNative(dir));
      const exists = await files.fs.exists(key);
      if (!exists.success || !exists.data.exists) return null;
      const listed = await runRuntimeLiveJob(filesContract.fs.enumerate, files.fs.enumerate, {
        path: key.path,
        options: { includeSymlinkFiles: false },
      });
      return listed.success ? listed.data.paths.map(String) : null;
    },
    async mtimeMs(path) {
      const stat = await files.fs.stat(fileKeyForAbsolutePath(hostPathFromNative(path)));
      return stat.success && stat.data.type === 'file' ? stat.data.mtimeMs : null;
    },
    async remove(path) {
      const removed = await files.fs.delete({
        ...fileKeyForAbsolutePath(hostPathFromNative(path)),
        recursive: false,
      });
      return removed.success;
    },
  };
}

/** SQLite zaman damgası: ISO ya da `CURRENT_TIMESTAMP` biçimi ("YYYY-MM-DD HH:MM:SS", UTC). */
export function parseRegistryTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Kayıt defterinde hâlâ duran halef sohbetlerin son kullanım zamanı. */
export async function registryLastUsedAt(
  db: AppDb,
  conversationIds: readonly string[]
): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  if (conversationIds.length === 0) return usage;
  const rows = await db
    .select({
      id: conversations.id,
      updatedAt: conversations.updatedAt,
      lastSessionActivityAt: conversations.lastSessionActivityAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(
      and(
        inArray(conversations.id, [...conversationIds]),
        isNull(conversations.untrackedAt),
        isNull(conversations.deletionTombstone)
      )
    );
  for (const row of rows) {
    const times = [row.updatedAt, row.lastSessionActivityAt, row.createdAt]
      .map(parseRegistryTime)
      .filter((time): time is number => time !== null);
    // Zamanı okunamayan ama duran sohbet korunur.
    usage.set(row.id, times.length > 0 ? Math.max(...times) : Number.POSITIVE_INFINITY);
  }
  return usage;
}

/**
 * Ana makine başına temizlik isteklerini seyreltir: aynı ana makinede süren bir temizlik varsa ya
 * da son temizlik `throttleMs` içindeyse yeni istek yok sayılır.
 */
export class TranscriptRetentionScheduler {
  private readonly lastRunAt = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly throttleMs: number = TRANSCRIPT_RETENTION_THROTTLE_MS
  ) {}

  async request<T>(hostKey: string, run: () => Promise<T>): Promise<T | null> {
    if (this.running.has(hostKey)) return null;
    const last = this.lastRunAt.get(hostKey);
    if (last !== undefined && this.now() - last < this.throttleMs) return null;
    this.running.add(hostKey);
    this.lastRunAt.set(hostKey, this.now());
    try {
      return await run();
    } finally {
      this.running.delete(hostKey);
    }
  }
}
