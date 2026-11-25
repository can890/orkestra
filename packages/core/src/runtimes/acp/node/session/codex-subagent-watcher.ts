import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { NormalizedEvent, NormalizedSubagentActivity } from '#runtimes/acp/api';
import { readableCodexTask } from '#runtimes/acp/api/codex-subagent-task';

/**
 * Codex'in kendi alt ajanlarının (çoklu ajan araçları `spawn_agent`, `wait_agent`, …) gerçek
 * durumunu izler.
 *
 * Neden gerekli: gömülü codex-acp bağdaştırıcısı alt ajanın kendi olaylarını (adımları, tur
 * bitişi) yalnızca "native subagent sessions" yeteneğini bildiren istemcilere iletir. Orkestra bu
 * yeteneği kullanmaz; akışa yalnızca ana ajanın "alt ajan başlatıldı / mesaj gönderildi /
 * durduruldu" satırları düşer, alt ajanın ne zaman ve nasıl bittiği düşmez. Codex ise her alt
 * ajanın bütün etkinliğini kendi oturum kaydına yazar:
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<zaman>-<thread id>.jsonl`. Bu sınıf o kaydın yalnızca
 * yeni eklenen kısmını okuyup ajanın son turunun durumunu (`task_started` → çalışıyor,
 * `task_complete` → tamamlandı + son yanıt, `turn_aborted` → durduruldu/hata), modelini ve
 * adımlarını `subagent_update` olarak bildirir. Görev metni ana ajanın kaydındaki `spawn_agent`
 * çağrısından (çağrı kimliği satırın araç çağrısı kimliğidir) okunur.
 *
 * Zamandan tahmin yapılmaz: durum yalnızca kayıttaki olaylardan gelir. Geri yüklenen bir oturumda
 * kaydın sonuna kadar okunduğu hâlde bitişi görülmeyen ajanın akıbeti "bilinmiyor" olur (önceki
 * süreç kapandı, ajan artık çalışamaz).
 */

export type CodexSubagentUpdateEvent = Extract<NormalizedEvent, { kind: 'subagent_update' }>;

export type CodexSubagentWatcherOptions = {
  onUpdate: (event: CodexSubagentUpdateEvent) => void;
  /** Ana ajanın Codex thread kimliği (ACP oturum kimliği); görev metni onun kaydından okunur. */
  parentThreadId?: string;
  /** Codex yapılandırma dizini (varsayılan `CODEX_HOME` ya da `~/.codex`). */
  codexHome?: string;
  intervalMs?: number;
};

export type CodexSubagentRegistration = {
  toolCallId: string;
  /** Alt ajanın Codex thread kimliği. */
  agentId: string;
};

export type CodexRolloutState = {
  status: 'running' | 'completed' | 'failed';
  interrupted?: true;
  summary?: string;
  model?: string;
  effort?: string;
  activities: NormalizedSubagentActivity[];
  /** Kayıtta en az bir tur başlangıcı ya da bitişi görüldü. */
  turnSeen: boolean;
};

type FileCursor = {
  offset: number;
  remainder: string;
  decoder: StringDecoder;
};

type Entry = CodexSubagentRegistration & {
  file: string | null;
  resolveAttempts: number;
  cursor: FileCursor | null;
  state: CodexRolloutState;
  lastSerialized: string;
  /** Oturum geri yüklenirken (geçmiş yeniden oynatılırken) kaydedildi. */
  restored: boolean;
  /** Geri yükleme bitti: kayıt sonuna kadar okununca hâlâ çalışıyorsa akıbeti bilinmiyor. */
  expireWhenScanned: boolean;
};

type SpawnCall = { prompt?: string; model?: string; role?: string };

const DEFAULT_POLL_INTERVAL_MS = 1000;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_RESOLVE_ATTEMPTS = 60;
const MAX_ACTIVITIES = 40;
const MAX_SUMMARY_CHARS = 16_000;
const MAX_DETAIL_CHARS = 280;
const MAX_PROMPT_CHARS = 16_000;
const INTERRUPTED_SUMMARY = 'Alt ajan durduruldu.';
const SAFE_THREAD_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const UUID_V7_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const SPAWN_TOOL_NAMES = new Set(['spawn_agent']);

export function resolveCodexHome(codexHome?: string): string {
  return codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export function initialRolloutState(): CodexRolloutState {
  return { status: 'running', activities: [], turnSeen: false };
}

function cap(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function joinText(value: unknown): string | undefined {
  if (typeof value === 'string') return nonEmpty(value);
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    if (typeof part === 'string') return part.trim() ? [part] : [];
    const text = asRecord(part)?.text;
    return typeof text === 'string' && text.trim() ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n').trim() : undefined;
}

function commandText(value: unknown): string | undefined {
  if (typeof value === 'string') return nonEmpty(value);
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    // `["bash", "-lc", "<komut>"]` biçiminde gelir; asıl komut son öğedir.
    const parts = value as string[];
    const last = parts.at(-1);
    return parts.length >= 3 && /(?:^|\/)(?:ba|z)?sh$/.test(parts[0] ?? '')
      ? nonEmpty(last)
      : nonEmpty(parts.join(' '));
  }
  return undefined;
}

function pushActivity(state: CodexRolloutState, activity: NormalizedSubagentActivity): void {
  state.activities.push(activity);
  if (state.activities.length > MAX_ACTIVITIES) {
    state.activities.splice(0, state.activities.length - MAX_ACTIVITIES);
  }
}

function itemActivity(
  item: Record<string, unknown>,
  timestamp: number | undefined
): NormalizedSubagentActivity | null {
  const id = nonEmpty(item.id);
  if (!id) return null;
  const at = timestamp !== undefined ? { timestamp } : {};
  switch (item.type) {
    case 'CommandExecution': {
      const command = commandText(item.command);
      const exitCode = item.exit_code;
      return {
        id,
        kind: 'tool',
        title: 'Komut çalıştırıldı',
        ...(command ? { detail: cap(command, MAX_DETAIL_CHARS) } : {}),
        status: typeof exitCode === 'number' && exitCode !== 0 ? 'error' : 'done',
        ...at,
      };
    }
    case 'McpToolCall': {
      const name = [nonEmpty(item.server), nonEmpty(item.tool)].filter(Boolean).join('.');
      return {
        id,
        kind: 'tool',
        title: 'Araç kullanıldı',
        ...(name ? { detail: name } : {}),
        status: item.status === 'failed' ? 'error' : 'done',
        ...at,
      };
    }
    case 'FileChange': {
      const changes = asRecord(item.changes);
      const paths = changes ? Object.keys(changes) : [];
      return {
        id,
        kind: 'tool',
        title: 'Dosya değiştirildi',
        ...(paths.length > 0 ? { detail: cap(paths.join(', '), MAX_DETAIL_CHARS) } : {}),
        status: item.status === 'failed' ? 'error' : 'done',
        ...at,
      };
    }
    case 'WebSearch': {
      const query = nonEmpty(item.query);
      return {
        id,
        kind: 'tool',
        title: 'Web araması',
        ...(query ? { detail: cap(query, MAX_DETAIL_CHARS) } : {}),
        status: 'done',
        ...at,
      };
    }
    case 'AgentMessage': {
      const text = joinText(item.content);
      return text
        ? { id, kind: 'message', title: 'Mesaj', detail: cap(text, MAX_DETAIL_CHARS), ...at }
        : null;
    }
    case 'Reasoning': {
      const text = joinText(item.summary_text);
      return text
        ? { id, kind: 'thinking', title: 'Düşündü', detail: cap(text, MAX_DETAIL_CHARS), ...at }
        : null;
    }
    default:
      return null;
  }
}

function recordTimestamp(record: Record<string, unknown>): number | undefined {
  const value = record.timestamp;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Alt ajanın oturum kaydındaki tek bir JSONL satırını duruma uygular. Satır anlaşılmazsa durum
 * değişmez. Yalnızca kayıttaki olaylar durumu belirler; son turun sonucu geçerlidir.
 */
export function applyRolloutLine(state: CodexRolloutState, line: string): void {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const record = asRecord(parsed);
  const payload = asRecord(record?.payload);
  if (!record || !payload) return;
  if (record.type === 'turn_context') {
    const model = nonEmpty(payload.model);
    const effort = nonEmpty(payload.effort);
    if (model) state.model = model;
    if (effort) state.effort = effort;
    return;
  }
  if (record.type !== 'event_msg') return;
  switch (payload.type) {
    case 'task_started':
      state.status = 'running';
      state.turnSeen = true;
      delete state.interrupted;
      delete state.summary;
      return;
    case 'task_complete': {
      state.status = 'completed';
      state.turnSeen = true;
      delete state.interrupted;
      const message = nonEmpty(payload.last_agent_message);
      if (message) state.summary = cap(message, MAX_SUMMARY_CHARS);
      else delete state.summary;
      return;
    }
    case 'turn_aborted': {
      state.status = 'failed';
      state.turnSeen = true;
      if (payload.reason === 'interrupted') {
        state.interrupted = true;
        state.summary = INTERRUPTED_SUMMARY;
      } else {
        delete state.interrupted;
        const reason = nonEmpty(payload.reason);
        state.summary = reason ? `Alt ajan durdu (${reason}).` : 'Alt ajan durdu.';
      }
      return;
    }
    case 'item_completed': {
      const item = asRecord(payload.item);
      if (!item) return;
      const activity = itemActivity(item, recordTimestamp(record));
      if (activity) pushActivity(state, activity);
      return;
    }
    default:
      return;
  }
}

/** Ana ajanın kaydındaki `spawn_agent` çağrısından görev metnini, modeli ve rolü çıkarır. */
export function parseSpawnCallLine(line: string): { callId: string; call: SpawnCall } | null {
  if (!line.includes('"function_call"') || !line.includes('spawn_agent')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = asRecord(asRecord(parsed)?.payload);
  if (!payload || payload.type !== 'function_call') return null;
  const name = nonEmpty(payload.name);
  const callId = nonEmpty(payload.call_id);
  if (!name || !SPAWN_TOOL_NAMES.has(name) || !callId) return null;
  let args: Record<string, unknown> | undefined;
  try {
    args = asRecord(
      typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments
    );
  } catch {
    args = undefined;
  }
  if (!args) return { callId, call: {} };
  const prompt = readableCodexTask(args.message, args.prompt, args.task);
  const model = nonEmpty(args.model);
  const role = nonEmpty(args.agent_type) ?? nonEmpty(args.role);
  return {
    callId,
    call: {
      ...(prompt ? { prompt: cap(prompt, MAX_PROMPT_CHARS) } : {}),
      ...(model ? { model } : {}),
      ...(role ? { role } : {}),
    },
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dayDir(sessionsDir: string, ms: number): string {
  const date = new Date(ms);
  return join(
    sessionsDir,
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  );
}

/** UUIDv7 thread kimliğinin oluşturulma zamanı (ms); başka biçimde `undefined`. */
export function threadIdTimestamp(threadId: string): number | undefined {
  const match = UUID_V7_RE.exec(threadId);
  if (!match) return undefined;
  const ms = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isFinite(ms) ? ms : undefined;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Kaydı thread kimliğinden bulur: oluşturulma gününün dizini (yerel saat) ve komşu günler. */
export async function findRolloutFile(
  codexHome: string,
  threadId: string,
  now = Date.now()
): Promise<string | null> {
  if (!SAFE_THREAD_ID_RE.test(threadId)) return null;
  const sessionsDir = join(codexHome, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const created = threadIdTimestamp(threadId);
  const days = created !== undefined ? [created, created - DAY_MS, created + DAY_MS] : [];
  // Kimlikten gün çıkmıyorsa son günlere bak.
  if (created === undefined) days.push(now, now - DAY_MS, now - 2 * DAY_MS);
  const seen = new Set<string>();
  for (const ms of days) {
    const dir = dayDir(sessionsDir, ms);
    if (seen.has(dir)) continue;
    seen.add(dir);
    const name = (await listDir(dir)).find(
      (candidate) => candidate.startsWith('rollout-') && candidate.endsWith(suffix)
    );
    if (name) return join(dir, name);
  }
  return null;
}

function serialize(state: CodexRolloutState, spawn: SpawnCall | undefined): string {
  return JSON.stringify({
    status: state.status,
    interrupted: state.interrupted ?? false,
    summary: state.summary ?? null,
    model: state.model ?? spawn?.model ?? null,
    effort: state.effort ?? null,
    prompt: spawn?.prompt ?? null,
    role: spawn?.role ?? null,
    activities: state.activities.map((activity) => activity.id),
  });
}

export class CodexSubagentWatcher {
  private readonly onUpdate: (event: CodexSubagentUpdateEvent) => void;
  private readonly intervalMs: number;
  private readonly codexHome: string;
  private parentThreadId: string | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly spawnCalls = new Map<string, SpawnCall>();
  private parentFile: string | null = null;
  private parentCursor: FileCursor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private repollRequested = false;
  private disposed = false;
  private restoring = false;

  constructor(options: CodexSubagentWatcherOptions) {
    this.onUpdate = options.onUpdate;
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.codexHome = resolveCodexHome(options.codexHome);
    this.parentThreadId = options.parentThreadId;
  }

  get activeCount(): number {
    return this.entries.size;
  }

  /** Ana ajanın thread kimliği değişti (oturum yeniden bağlandı). */
  setParentThreadId(threadId: string): void {
    if (threadId === this.parentThreadId) return;
    this.parentThreadId = threadId;
    this.parentFile = null;
    this.parentCursor = null;
  }

  register(registration: CodexSubagentRegistration): void {
    if (this.disposed) return;
    if (!registration.toolCallId || !SAFE_THREAD_ID_RE.test(registration.agentId)) return;
    if (this.entries.has(registration.toolCallId)) return;
    // Aynı ajan birden çok satırla bildirilebilir (v1: `spawnAgent` + başlatma etkinliği); kayıt tek
    // kez okunur, kart ajan kimliğiyle eşleşir.
    for (const entry of this.entries.values()) {
      if (entry.agentId === registration.agentId) return;
    }
    this.entries.set(registration.toolCallId, {
      ...registration,
      file: null,
      resolveAttempts: 0,
      cursor: null,
      state: initialRolloutState(),
      lastSerialized: '',
      restored: this.restoring,
      expireWhenScanned: false,
    });
    this.ensureTimer();
    void this.poll();
  }

  /** Oturum geçmişi yeniden oynatılmaya başladı; bu sırada gelen kayıtlar "geri yüklenmiş" sayılır. */
  beginRestore(): void {
    this.restoring = true;
  }

  /**
   * Geçmiş yeniden oynatıldı. Geri yüklenen kayıtlar bir kez sonuna kadar okununca, son turu hâlâ
   * bitmemiş görünen ajanın akıbeti "bilinmiyor" olur ve izleme bırakılır.
   */
  endRestore(): void {
    this.restoring = false;
    let pending = false;
    for (const entry of this.entries.values()) {
      if (!entry.restored) continue;
      entry.expireWhenScanned = true;
      pending = true;
    }
    if (pending) void this.poll();
  }

  async poll(): Promise<void> {
    if (this.disposed) return;
    if (this.polling) {
      this.repollRequested = true;
      await this.polling;
      return;
    }
    const run = async () => {
      do {
        this.repollRequested = false;
        await this.pollOnce();
      } while (this.repollRequested && !this.disposed && this.entries.size > 0);
    };
    this.polling = run().finally(() => {
      this.polling = null;
    });
    await this.polling;
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.spawnCalls.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ensureTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  private stopTimerIfIdle(): void {
    if (this.entries.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async pollOnce(): Promise<void> {
    if (this.entries.size === 0) return;
    await this.readParent();
    for (const entry of [...this.entries.values()]) {
      if (this.disposed) return;
      if (!entry.file) {
        entry.file = await findRolloutFile(this.codexHome, entry.agentId);
        if (!entry.file) {
          entry.resolveAttempts += 1;
          // Kayıt bulunamıyor: ajanın sonucu hiçbir zaman okunamayacak. Başlatma bilgisi (görev,
          // model) yine bildirilir; durum "bilinmiyor" olur, "çalışıyor" diye bırakılmaz.
          if (entry.expireWhenScanned || entry.resolveAttempts >= MAX_RESOLVE_ATTEMPTS) {
            this.emit(entry);
            this.expire(entry);
          } else {
            this.emit(entry);
          }
          continue;
        }
      }
      const readToEnd = await this.readAppended(entry);
      this.emit(entry);
      if (entry.expireWhenScanned && readToEnd) {
        if (entry.state.status === 'running') this.expire(entry);
        else this.entries.delete(entry.toolCallId);
      }
    }
    this.stopTimerIfIdle();
  }

  private emit(entry: Entry): void {
    if (this.entries.get(entry.toolCallId) !== entry) return;
    const spawn = this.spawnCalls.get(entry.toolCallId);
    const serialized = serialize(entry.state, spawn);
    if (serialized === entry.lastSerialized) return;
    // Henüz hiçbir bilgi yok (kayıt yok, görev metni okunmadı): boş bildirim gönderme.
    const empty = initialRolloutState();
    if (entry.lastSerialized === '' && serialized === serialize(empty, undefined)) return;
    entry.lastSerialized = serialized;
    const { state } = entry;
    const model = state.model ?? spawn?.model;
    this.onUpdate({
      kind: 'subagent_update',
      toolCallId: entry.toolCallId,
      agentId: entry.agentId,
      status:
        state.status === 'completed'
          ? 'completed'
          : state.status === 'failed'
            ? 'failed'
            : 'in_progress',
      ...(state.interrupted && state.status === 'failed' ? { interrupted: true as const } : {}),
      ...(state.summary !== undefined ? { summary: state.summary } : {}),
      ...(spawn?.prompt !== undefined ? { prompt: spawn.prompt } : {}),
      ...(spawn?.role !== undefined ? { role: spawn.role } : {}),
      provider: 'codex',
      ...(model !== undefined ? { model } : {}),
      ...(state.effort !== undefined ? { effort: state.effort } : {}),
      ...(state.activities.length > 0 ? { activities: [...state.activities] } : {}),
    });
  }

  private expire(entry: Entry): void {
    if (this.entries.get(entry.toolCallId) !== entry) return;
    this.entries.delete(entry.toolCallId);
    if (entry.state.status !== 'running') return;
    this.onUpdate({
      kind: 'subagent_update',
      toolCallId: entry.toolCallId,
      agentId: entry.agentId,
      status: 'completed',
      statusUnknown: true,
    });
  }

  private async readParent(): Promise<void> {
    const parent = this.parentThreadId;
    if (!parent) return;
    const needsPrompt = [...this.entries.values()].some(
      (entry) => !this.spawnCalls.has(entry.toolCallId)
    );
    if (!needsPrompt) return;
    if (!this.parentFile) {
      this.parentFile = await findRolloutFile(this.codexHome, parent);
      if (!this.parentFile) return;
    }
    this.parentCursor ??= { offset: 0, remainder: '', decoder: new StringDecoder('utf8') };
    await readLines(
      this.parentFile,
      this.parentCursor,
      () => this.disposed,
      (line) => {
        const spawn = parseSpawnCallLine(line);
        if (spawn) this.spawnCalls.set(spawn.callId, spawn.call);
      }
    );
  }

  /** Kaydın eklenen kısmını okur; dosya sonuna kadar okunduysa `true` döner. */
  private async readAppended(entry: Entry): Promise<boolean> {
    if (!entry.file) return false;
    entry.cursor ??= { offset: 0, remainder: '', decoder: new StringDecoder('utf8') };
    return readLines(
      entry.file,
      entry.cursor,
      () => this.disposed,
      (line) => applyRolloutLine(entry.state, line),
      () => {
        entry.state = initialRolloutState();
      }
    );
  }
}

async function readLines(
  file: string,
  cursor: FileCursor,
  disposed: () => boolean,
  onLine: (line: string) => void,
  onReset?: () => void
): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return false;
  }
  if (size < cursor.offset) {
    // Kayıt kısalmış (yeniden yazılmış): durum birikimli olduğundan sıfırlanıp baştan okunur.
    cursor.offset = 0;
    cursor.remainder = '';
    cursor.decoder = new StringDecoder('utf8');
    onReset?.();
  }
  if (size === cursor.offset) return true;
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (cursor.offset < size && !disposed()) {
      const length = Math.min(READ_CHUNK_BYTES, size - cursor.offset);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      if (bytesRead <= 0) break;
      cursor.offset += bytesRead;
      const text = cursor.remainder + cursor.decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split('\n');
      cursor.remainder = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
  } finally {
    await handle.close();
  }
  return cursor.offset >= size && !disposed();
}
