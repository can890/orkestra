import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { TranscriptMessage, TranscriptTurn } from '@orkestra/core/runtimes/acp/api/client';
import { log } from '@orkestra/shared/logger';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { kv } from '@core/services/app-db/node/schema';

const CACHE_KEY_PREFIX = 'transcript:cache:';
const MAX_CACHED_TURNS = 120;
const MAX_CACHE_JSON_BYTES = 1_500_000;
const MAX_DISK_FILE_BYTES = 10 * 1024 * 1024;
const DISK_INDEX_TTL_MS = 30_000;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const HIDDEN_CONTEXT_RE = /<orkestra_context>[\s\S]*?<\/orkestra_context>/g;
const UNTERMINATED_CONTEXT_RE = /<orkestra_context>[\s\S]*$/;
const BOILERPLATE_PREFIXES = [
  '# AGENTS.md',
  '<INSTRUCTIONS>',
  '<environment_context>',
  '<external_codex_apps',
  '<permissions instructions>',
  '<user_shell_command>',
  '<local-command',
  '<command-name>',
  '<system-reminder>',
];

export type InstantTranscriptSource = 'cache' | 'disk' | 'fts' | 'empty';

export type InstantTranscriptResult = {
  turns: TranscriptTurn[];
  source: InstantTranscriptSource;
};

type ParsedMessage = {
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt?: number;
};

type BetterSqliteLike = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

type FtsMessageRow = {
  item_id: string;
  role: string;
  content: string;
  created_at: number | null;
};

function cacheKey(conversationId: string): string {
  return `${CACHE_KEY_PREFIX}${conversationId}`;
}

/**
 * Sohbet yeni bir ajan oturumuyla sürdürüldüğünde (kayıtlı oturum sağlayıcıda artık yok) eski
 * oturumun görünen turları. Ajan bunları hatırlamaz; yalnızca ekranda önceki bölüm olarak kalır.
 */
const EARLIER_KEY_PREFIX = 'transcript:earlier:';

function earlierKey(conversationId: string): string {
  return `${EARLIER_KEY_PREFIX}${conversationId}`;
}

function unixNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function stripOrkestraContext(text: string): string {
  return text.replace(HIDDEN_CONTEXT_RE, '').replace(UNTERMINATED_CONTEXT_RE, '').trim();
}

function isBoilerplateMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return BOILERPLATE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseTimestampMs(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.round(raw) : Math.round(raw * 1000);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function extractTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (
      (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') &&
      typeof block.text === 'string'
    ) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function parseAntigravityMessages(raw: string, fallbackTs: number): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = parseTimestampMs(obj.timestamp ?? obj.createdAt ?? obj.created_at, fallbackTs);
    if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
      const reqStart = obj.content.indexOf('<USER_REQUEST>');
      let extracted = obj.content;
      if (reqStart >= 0) {
        const from = reqStart + '<USER_REQUEST>'.length;
        const reqEnd = obj.content.lastIndexOf('</USER_REQUEST>');
        extracted = obj.content.slice(from, reqEnd >= from ? reqEnd : undefined);
      }
      const clean = stripOrkestraContext(extracted);
      if (!clean || isBoilerplateMessage(clean)) continue;
      out.push({
        itemId: typeof obj.id === 'string' && obj.id ? obj.id : `agy-user-${i}`,
        role: 'user',
        text: clean,
        createdAt: ts,
      });
    } else if (obj.type === 'PLANNER_RESPONSE' && typeof obj.content === 'string') {
      const clean = stripOrkestraContext(obj.content);
      if (!clean) continue;
      out.push({
        itemId: typeof obj.id === 'string' && obj.id ? obj.id : `agy-assistant-${i}`,
        role: 'assistant',
        text: clean,
        createdAt: ts,
      });
    }
  }
  return out;
}

function parseClaudeMessages(raw: string, fallbackTs: number): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.isSidechain === true || obj.isMeta === true) continue;
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const msg =
      obj.message && typeof obj.message === 'object'
        ? (obj.message as Record<string, unknown>)
        : undefined;
    const rawText = extractTextBlocks(msg?.content ?? obj.content);
    const clean = stripOrkestraContext(rawText);
    if (!clean || (obj.type === 'user' && isBoilerplateMessage(clean))) continue;
    const ts = parseTimestampMs(obj.timestamp, fallbackTs);
    out.push({
      itemId: typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : `claude-${obj.type}-${i}`,
      role: obj.type,
      text: clean,
      createdAt: ts,
    });
  }
  return out;
}

function parseCodexMessages(raw: string, fallbackTs: number): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const seenKey = new Set<string>();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload =
      obj.payload && typeof obj.payload === 'object'
        ? (obj.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;

    let role: 'user' | 'assistant' | null = null;
    let rawText = '';
    if (obj.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        role = 'user';
        rawText = payload.message;
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
        role = 'assistant';
        rawText = payload.message;
      }
    } else if (
      obj.type === 'response_item' &&
      (payload.role === 'user' || payload.role === 'assistant')
    ) {
      role = payload.role;
      rawText = extractTextBlocks(payload.content);
    }

    if (!role) continue;
    const clean = stripOrkestraContext(rawText);
    if (!clean || (role === 'user' && isBoilerplateMessage(clean))) continue;
    const dedup = `${role}:${clean}`;
    if (seenKey.has(dedup)) continue;
    seenKey.add(dedup);
    const ts = parseTimestampMs(obj.timestamp ?? payload.timestamp, fallbackTs);
    out.push({
      itemId: typeof payload.id === 'string' && payload.id ? payload.id : `codex-${role}-${i}`,
      role,
      text: clean,
      createdAt: ts,
    });
  }
  return out;
}

async function readFileBounded(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0 || info.size > MAX_DISK_FILE_BYTES) return null;
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function scanClaudeSessionFiles(home: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const projectsDir = join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return result;
  }
  for (const dir of dirs) {
    const fullDir = join(projectsDir, dir);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sid = entry.slice(0, -'.jsonl'.length);
      if (sid && !result.has(sid)) {
        result.set(sid, join(fullDir, entry));
      }
    }
  }
  return result;
}

async function scanCodexSessionFiles(home: string): Promise<Array<{ name: string; path: string }>> {
  const result: Array<{ name: string; path: string }> = [];
  const root = join(home, '.codex', 'sessions');
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.push({ name: basename(entry.name), path: full });
      }
    }
  };
  await walk(root, 0);
  return result;
}

/** Düz mesaj listesini ACP `TranscriptTurn[]` yapısına dönüştürür. */
export function messagesToTranscriptTurns(
  conversationId: string,
  messages: readonly ParsedMessage[]
): TranscriptTurn[] {
  if (messages.length === 0) return [];
  const turns: TranscriptTurn[] = [];
  let current: {
    id: string;
    seq: number;
    initiator: 'user' | 'agent';
    items: TranscriptMessage[];
  } | null = null;
  let turnSeq = 0;

  for (const msg of messages) {
    if (msg.role === 'user' || !current) {
      if (current) {
        turns.push({
          ...current,
          outcome: { kind: 'done', reason: 'end_turn' },
        });
      }
      turnSeq += 1;
      current = {
        id: `cached:${conversationId}:t${turnSeq}`,
        seq: turnSeq,
        initiator: msg.role === 'user' ? 'user' : 'agent',
        items: [],
      };
    }
    current.items.push({
      kind: 'message',
      id: msg.itemId || `cached:${conversationId}:m${turnSeq}-${current.items.length + 1}`,
      seq: current.items.length + 1,
      role: msg.role,
      text: msg.text,
      ...(msg.createdAt !== undefined ? { createdAt: msg.createdAt } : {}),
    });
  }
  if (current) {
    turns.push({
      ...current,
      outcome: { kind: 'done', reason: 'end_turn' },
    });
  }
  return turns.length > MAX_CACHED_TURNS ? turns.slice(turns.length - MAX_CACHED_TURNS) : turns;
}

function serializeTurnsBounded(turns: readonly TranscriptTurn[]): string | null {
  if (turns.length === 0) return null;
  let slice =
    turns.length > MAX_CACHED_TURNS ? turns.slice(turns.length - MAX_CACHED_TURNS) : [...turns];
  while (slice.length > 0) {
    try {
      const json = JSON.stringify(slice);
      if (Buffer.byteLength(json, 'utf8') <= MAX_CACHE_JSON_BYTES) return json;
    } catch {
      return null;
    }
    if (slice.length <= 1) return null;
    slice = slice.slice(Math.ceil(slice.length / 2));
  }
  return null;
}

function rawSqliteClient(db: AppDb): BetterSqliteLike | null {
  const rec = db as unknown as {
    $client?: BetterSqliteLike;
    session?: { client?: BetterSqliteLike };
  };
  const client = rec.$client ?? rec.session?.client;
  if (!client || typeof client.prepare !== 'function') return null;
  return client;
}

/**
 * Ana süreçte (CLI başlatmadan / SSH beklemeden) sohbet transkriptlerini milisaniyeler içinde
 * sunan kalıcı önbellek ve disk okuyucu.
 *
 * Okuma şelalesi:
 * 1. SQLite `kv` (`transcript:cache:<id>`) — tam zengin ACP transkripti (~1 ms)
 * 2. Yerel sağlayıcı disk günlüğü (Antigravity / Claude / Codex) — CLI açmadan (~5 ms)
 * 3. `message_search_fts` — yerel ve uzak (SSH) sohbetlerin indekslenmiş mesajları (~2 ms)
 */
export class ConversationTranscriptCache {
  private readonly homeDir: string;
  private claudeIndex: { at: number; map: Map<string, string> } | null = null;
  private codexIndex: { at: number; files: Array<{ name: string; path: string }> } | null = null;
  private prewarmScheduled = false;

  constructor(
    private readonly db: AppDb,
    options?: { homeDir?: string }
  ) {
    this.homeDir = options?.homeDir ?? homedir();
  }

  /** Canlı `loadHistory` sonrası son turları SQLite `kv` tablosuna yazar. */
  save(conversationId: string, turns: readonly TranscriptTurn[]): void {
    if (!conversationId || turns.length === 0) return;
    if (typeof this.db?.insert !== 'function') return;
    const json = serializeTurnsBounded(turns);
    if (!json) return;
    try {
      this.db
        .insert(kv)
        .values({
          key: cacheKey(conversationId),
          value: json,
          updatedAt: unixNowSeconds(),
        })
        .onConflictDoUpdate({
          target: kv.key,
          set: { value: json, updatedAt: unixNowSeconds() },
        })
        .run();
    } catch {
      // Önbellek yazma hatası canlı akışı asla engellemez.
    }
  }

  /** Silinen sohbetin önbelleğini (önceki oturumun turları dahil) temizler. */
  remove(conversationId: string): void {
    if (!conversationId || typeof this.db?.delete !== 'function') return;
    for (const key of [cacheKey(conversationId), earlierKey(conversationId)]) {
      try {
        this.db.delete(kv).where(eq(kv.key, key)).run();
      } catch {
        // Yoksay
      }
    }
  }

  /** Sohbetin önceki (ajanın artık hatırlamadığı) oturumlarından kalan görünen turlar. */
  readEarlierTurns(conversationId: string): TranscriptTurn[] {
    return this.readTurns(earlierKey(conversationId)) ?? [];
  }

  /**
   * Kayıtlı oturum yerine yeni bir oturum başladığında, o ana kadar önbellekte duran turları
   * "önceki turlar" olarak saklar ve geçerli önbelleği boşaltır: yeni oturumun geçmişi ayrı tutulur,
   * eski turlar ekranda kalır ama mevcut geçmiş gibi gösterilmez.
   */
  preserveAsEarlierTurns(conversationId: string): void {
    if (!conversationId || typeof this.db?.insert !== 'function') return;
    const current = this.readFromKv(conversationId) ?? [];
    if (current.length === 0) return;
    const json = serializeTurnsBounded([...this.readEarlierTurns(conversationId), ...current]);
    if (!json) return;
    try {
      this.db
        .insert(kv)
        .values({ key: earlierKey(conversationId), value: json, updatedAt: unixNowSeconds() })
        .onConflictDoUpdate({
          target: kv.key,
          set: { value: json, updatedAt: unixNowSeconds() },
        })
        .run();
      this.db
        .delete(kv)
        .where(eq(kv.key, cacheKey(conversationId)))
        .run();
    } catch {
      // Önbellek yazma hatası canlı akışı asla engellemez.
    }
  }

  /** CLI veya SSH beklemeksizin mevcut en hızlı transkripti (< 15 ms) döndürür. */
  async readInstantTranscript(conversationId: string): Promise<InstantTranscriptResult> {
    if (!conversationId) return { turns: [], source: 'empty' };

    // 1) SQLite kv önbelleği (~1 ms)
    const cached = this.readFromKv(conversationId);
    if (cached && cached.length > 0) {
      return { turns: cached, source: 'cache' };
    }

    // 2) Yerel sağlayıcı disk dosyası (Antigravity / Claude / Codex) (~5 ms)
    const fromDisk = await this.readFromLocalDisk(conversationId);
    if (fromDisk.length > 0) {
      this.save(conversationId, fromDisk);
      return { turns: fromDisk, source: 'disk' };
    }

    // 3) message_search_fts tablosu (hem yerel hem uzak SSH sohbetler için ~2 ms)
    const fromFts = this.readFromMessageFts(conversationId);
    if (fromFts.length > 0) {
      return { turns: fromFts, source: 'fts' };
    }

    return { turns: [], source: 'empty' };
  }

  /** Açılıştan kısa süre sonra henüz önbelleklenmemiş yerel sohbetleri sessizce SQLite'a ısıtır. */
  schedulePrewarm(delayMs = 2_000): void {
    if (this.prewarmScheduled || typeof this.db?.select !== 'function') return;
    this.prewarmScheduled = true;
    const timer = setTimeout(() => {
      void this.prewarmLocalConversations();
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async prewarmLocalConversations(): Promise<number> {
    if (typeof this.db?.select !== 'function') return 0;
    try {
      const rows = this.db
        .select({
          id: conversations.id,
          provider: conversations.provider,
          providerSessionId: conversations.providerSessionId,
          location: conversations.location,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(and(isNull(conversations.untrackedAt), isNotNull(conversations.providerSessionId)))
        .all();

      let warmed = 0;
      for (const row of rows) {
        if (row.location === 'remote') continue;
        if (!row.providerSessionId || !SAFE_SESSION_ID_RE.test(row.providerSessionId)) continue;
        if (this.readFromKv(row.id)) continue;

        const turns = await this.readLocalProviderFile(
          row.id,
          row.provider,
          row.providerSessionId,
          row.createdAt
        );
        if (turns.length > 0) {
          this.save(row.id, turns);
          warmed += 1;
        }
        // Olay döngüsünü tıkamamak için dosyalar arasında kısa nefes ver.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (warmed > 0) {
        log.info('ConversationTranscriptCache: prewarmed local conversation transcripts', {
          warmed,
        });
      }
      return warmed;
    } catch {
      return 0;
    }
  }

  private readFromKv(conversationId: string): TranscriptTurn[] | null {
    return this.readTurns(cacheKey(conversationId));
  }

  private readTurns(key: string): TranscriptTurn[] | null {
    if (typeof this.db?.select !== 'function') return null;
    try {
      const row = this.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get();
      if (!row?.value) return null;
      const parsed: unknown = JSON.parse(row.value);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      return parsed as TranscriptTurn[];
    } catch {
      return null;
    }
  }

  private async readFromLocalDisk(conversationId: string): Promise<TranscriptTurn[]> {
    if (typeof this.db?.select !== 'function') return [];
    try {
      const row = this.db
        .select({
          provider: conversations.provider,
          providerSessionId: conversations.providerSessionId,
          location: conversations.location,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get();
      if (!row || row.location === 'remote' || !row.providerSessionId) return [];
      if (!SAFE_SESSION_ID_RE.test(row.providerSessionId)) return [];
      return await this.readLocalProviderFile(
        conversationId,
        row.provider,
        row.providerSessionId,
        row.createdAt
      );
    } catch {
      return [];
    }
  }

  private async readLocalProviderFile(
    conversationId: string,
    provider: string | null,
    providerSessionId: string,
    createdAt: string | null
  ): Promise<TranscriptTurn[]> {
    const fallbackTs = parseTimestampMs(createdAt, Date.now());
    let messages: ParsedMessage[] = [];

    if (provider === 'antigravity') {
      const candidateIds = new Set<string>([providerSessionId]);
      // Antigravity ACP köprüsü bridge sessionId -> nativeId eşlemesini state JSON'unda tutar.
      const statePath = join(
        this.homeDir,
        '.local',
        'state',
        'orkestra',
        'antigravity',
        `${providerSessionId}.json`
      );
      const stateRaw = await readFileBounded(statePath);
      if (stateRaw) {
        try {
          const parsed = JSON.parse(stateRaw) as { nativeId?: unknown };
          if (typeof parsed.nativeId === 'string' && SAFE_SESSION_ID_RE.test(parsed.nativeId)) {
            candidateIds.add(parsed.nativeId);
          }
        } catch {
          // Bozuk state JSON'unu yoksay
        }
      }
      const brainRoots = [
        join(this.homeDir, '.gemini', 'antigravity-cli', 'brain'),
        join(this.homeDir, '.gemini', 'antigravity', 'brain'),
      ];
      outer: for (const id of candidateIds) {
        for (const root of brainRoots) {
          const transcriptPath = join(root, id, '.system_generated', 'logs', 'transcript.jsonl');
          const raw = await readFileBounded(transcriptPath);
          if (raw) {
            messages = parseAntigravityMessages(raw, fallbackTs);
            if (messages.length > 0) break outer;
          }
        }
      }
    } else if (provider === 'claude') {
      const filePath = await this.findClaudeFile(providerSessionId);
      if (filePath) {
        const raw = await readFileBounded(filePath);
        if (raw) messages = parseClaudeMessages(raw, fallbackTs);
      }
    } else if (provider === 'codex') {
      const filePath = await this.findCodexFile(providerSessionId);
      if (filePath) {
        const raw = await readFileBounded(filePath);
        if (raw) messages = parseCodexMessages(raw, fallbackTs);
      }
    }

    if (messages.length === 0) return [];
    return messagesToTranscriptTurns(conversationId, messages);
  }

  private readFromMessageFts(conversationId: string): TranscriptTurn[] {
    try {
      let rows: FtsMessageRow[] = [];
      const sqlite = rawSqliteClient(this.db);
      if (sqlite) {
        const table = sqlite
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_search_fts' LIMIT 1`
          )
          .get();
        if (!table) return [];
        rows = sqlite
          .prepare(
            `SELECT item_id, role, content, created_at
               FROM message_search_fts
              WHERE conversation_id = ?
              ORDER BY rowid ASC
              LIMIT 240`
          )
          .all(conversationId) as FtsMessageRow[];
      } else if (typeof this.db?.all === 'function') {
        rows = this.db.all<FtsMessageRow>(
          sql`SELECT item_id, role, content, created_at
                FROM message_search_fts
               WHERE conversation_id = ${conversationId}
               ORDER BY rowid ASC
               LIMIT 240`
        );
      } else {
        return [];
      }
      if (!Array.isArray(rows) || rows.length === 0) return [];
      const messages: ParsedMessage[] = [];
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        if (!r || typeof r.content !== 'string' || !r.content.trim()) continue;
        const role = r.role === 'user' ? 'user' : 'assistant';
        messages.push({
          itemId: typeof r.item_id === 'string' && r.item_id ? r.item_id : `fts-${i}`,
          role,
          text: r.content,
          ...(typeof r.created_at === 'number' && Number.isFinite(r.created_at)
            ? { createdAt: r.created_at }
            : {}),
        });
      }
      return messagesToTranscriptTurns(conversationId, messages);
    } catch {
      return [];
    }
  }

  private async findClaudeFile(sessionId: string): Promise<string | null> {
    const now = Date.now();
    if (!this.claudeIndex || now - this.claudeIndex.at > DISK_INDEX_TTL_MS) {
      this.claudeIndex = { at: now, map: await scanClaudeSessionFiles(this.homeDir) };
    }
    return this.claudeIndex.map.get(sessionId) ?? null;
  }

  private async findCodexFile(sessionId: string): Promise<string | null> {
    const now = Date.now();
    if (!this.codexIndex || now - this.codexIndex.at > DISK_INDEX_TTL_MS) {
      this.codexIndex = { at: now, files: await scanCodexSessionFiles(this.homeDir) };
    }
    const match = this.codexIndex.files.find((f) => f.name.includes(sessionId));
    return match?.path ?? null;
  }
}
