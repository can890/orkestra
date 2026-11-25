import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { NormalizedEvent } from '#runtimes/acp/api';

/**
 * Arka planda başlatılan Claude alt ajanlarının (Agent aracı, `run_in_background`) bitişini izler.
 *
 * Neden gerekli: gömülü Claude ACP bağdaştırıcısı, arka plan görevi bittiğinde gelen
 * `task_notification` olayını yalnızca "native subagent sessions" yeteneğini bildiren istemcilere
 * iletir; Orkestra bu yeteneği kullanmadığı için bitiş bilgisi ACP akışına hiç düşmez ve ajan
 * panelde sonsuza dek "çalışıyor" kalır. Claude Code ise her bildirimi kendi oturum kaydına
 * (`<projects>/<slug>/<sessionId>.jsonl`) `queue-operation` / `enqueue` satırı olarak yazar; bu
 * sınıf o dosyanın yalnızca yeni eklenen kısmını okuyup eşleşen ajan için `subagent_update` üretir.
 *
 * Oturum dosyası, başlatma yanıtındaki `output_file` yolundan bulunur: bu yol
 * `<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl` dosyasına bir sembolik bağdır.
 */

export type BackgroundTaskUpdateEvent = Extract<NormalizedEvent, { kind: 'subagent_update' }>;

export type BackgroundTaskWatcherOptions = {
  onUpdate: (event: BackgroundTaskUpdateEvent) => void;
  intervalMs?: number;
  /** Testler için: Claude yapılandırma dizini (varsayılan `CLAUDE_CONFIG_DIR` ya da `~/.claude`). */
  claudeConfigDir?: string;
};

export type BackgroundTaskRegistration = {
  toolCallId: string;
  /** Claude görev kimliği; başlatma yanıtı gelmeden önce bilinmeyebilir. */
  agentId?: string;
  /** Başlatma yanıtındaki çıktı dosyası; oturum kaydını bulmanın birincil yolu. */
  outputFile?: string;
  /**
   * Claude oturum kimliği. Çıktı dosyası bilinmiyorsa (başlatma yanıtı akışta görünmediyse) oturum
   * kaydı, proje dizinlerinde `<sessionId>.jsonl` aranarak bulunur; bildirim araç çağrısı
   * kimliğiyle eşleştirilir.
   */
  sessionId?: string;
  /**
   * Kayıt, bitmiş bir ajanı yeniden başlatan çağrıya (Claude `SendMessage`) ait. Yalnızca bu
   * çağrının kimliğini taşıyan bildirim onu kapatır: aynı ajanın önceki bitiş bildirimi oturum
   * kaydında daha önce durur ve yeniden başlatılan çalışmayı "bitti" göstermemelidir.
   */
  resume?: boolean;
};

type Entry = BackgroundTaskRegistration & {
  /** Çözülmüş oturum kaydı yolu; çözülemediyse sonraki yoklamada yeniden denenir. */
  sessionFile: string | null;
  resolveAttempts: number;
  /**
   * Oturum kaydı bu kayıt için baştan tarandı mı? Sonradan eklenen bir ajanın bildirimi, dosya
   * imlecinin zaten geçtiği bir yerde olabilir (geçmiş yeniden yüklenirken ajanlar sırayla gelir).
   */
  scanned: boolean;
  /** Oturum geri yüklenirken (geçmiş yeniden oynatılırken) kaydedildi. */
  restored: boolean;
  /**
   * Geri yükleme bitti: oturum kaydı sonuna kadar okunduğunda hâlâ eşleşmemişse ajanın akıbeti
   * bilinmiyor demektir (ajanı çalıştıran süreç artık yok). Sonsuza dek "çalışıyor" kalmaz.
   */
  expireWhenScanned: boolean;
};

type FileCursor = {
  offset: number;
  remainder: string;
  decoder: StringDecoder;
};

export type ParsedTaskNotification = {
  taskId: string;
  toolUseId?: string;
  status: string;
  summary?: string;
  result?: string;
  outputFile?: string;
  /** Ajan kendi arka plan işini beklerken durdu; aynı görev için yeni bir bildirim gelebilir. */
  interim?: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_RESULT_CHARS = 16_000;
const MAX_RESOLVE_ATTEMPTS = 30;
const NOTIFICATION_MARKER = '<task-notification>';
const STOPPED_SUMMARY = 'Alt ajan durduruldu.';

const SUBAGENT_TRANSCRIPT_RE = /^(.*)[\\/]([^\\/]+)[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_OUTPUT_RE = /[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]tasks[\\/][^\\/]+\.output$/;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function tag(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

export function parseTaskNotificationText(text: string): ParsedTaskNotification | null {
  const start = text.indexOf(NOTIFICATION_MARKER);
  if (start < 0) return null;
  const body = text.slice(start);
  const taskId = tag(body, 'task-id');
  const status = tag(body, 'status');
  if (!taskId || !status) return null;
  const toolUseId = tag(body, 'tool-use-id');
  const summary = tag(body, 'summary');
  const result = tag(body, 'result');
  const outputFile = tag(body, 'output-file');
  const note = tag(body, 'note');
  const interim = Boolean(note && /background work of its own still running/i.test(note));
  return {
    taskId,
    status,
    ...(interim ? { interim } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
}

/** Oturum kaydındaki tek bir JSONL satırından bildirim metnini çıkarır (yoksa `null`). */
export function notificationTextFromTranscriptLine(line: string): string | null {
  if (!line.includes(NOTIFICATION_MARKER)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as {
    type?: unknown;
    operation?: unknown;
    content?: unknown;
    message?: { content?: unknown } | null;
  };
  if (record.type === 'queue-operation') {
    if (record.operation !== 'enqueue') return null;
    return typeof record.content === 'string' ? record.content : null;
  }
  if (record.type === 'user') {
    const content = record.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { type?: unknown; text?: unknown } | null)?.text;
        if (typeof text === 'string' && text.includes(NOTIFICATION_MARKER)) return text;
      }
    }
  }
  return null;
}

function toTerminalStatus(status: string): 'completed' | 'failed' | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'killed':
    case 'stopped':
    case 'cancelled':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}

function capResult(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS - 1)}…` : text;
}

export class BackgroundTaskWatcher {
  private readonly onUpdate: (event: BackgroundTaskUpdateEvent) => void;
  private readonly intervalMs: number;
  private readonly claudeConfigDir: string;
  private readonly entries = new Map<string, Entry>();
  private readonly cursors = new Map<string, FileCursor>();
  private readonly sessionFiles = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private repollRequested = false;
  private disposed = false;
  private restoring = false;

  constructor(options: BackgroundTaskWatcherOptions) {
    this.onUpdate = options.onUpdate;
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.claudeConfigDir =
      options.claudeConfigDir ??
      process.env.CLAUDE_CONFIG_DIR?.trim() ??
      join(homedir(), '.claude');
  }

  get activeCount(): number {
    return this.entries.size;
  }

  register(registration: BackgroundTaskRegistration): void {
    if (this.disposed) return;
    if (!registration.toolCallId) return;
    if (!registration.outputFile && !registration.sessionId) return;
    if (registration.resume && registration.agentId) {
      // Yeniden başlatılan ajanın önceki kayıtları geçersiz: eski bitişi yeni çalışmayı kapatmasın.
      for (const [toolCallId, entry] of this.entries) {
        if (entry.agentId === registration.agentId && toolCallId !== registration.toolCallId) {
          this.entries.delete(toolCallId);
        }
      }
    }
    const existing = this.entries.get(registration.toolCallId);
    if (existing) {
      // Başlatma yanıtı sonradan gelir: görev kimliğini ve çıktı dosyasını tamamla.
      if (registration.agentId && !existing.agentId) existing.agentId = registration.agentId;
      if (registration.outputFile && !existing.outputFile) {
        existing.outputFile = registration.outputFile;
        if (!existing.sessionFile) existing.resolveAttempts = 0;
      }
      if (registration.sessionId && !existing.sessionId)
        existing.sessionId = registration.sessionId;
      return;
    }
    this.entries.set(registration.toolCallId, {
      ...registration,
      sessionFile: null,
      resolveAttempts: 0,
      scanned: false,
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
   * Geçmiş yeniden oynatıldı. Geri yüklenen ve hâlâ eşleşmemiş kayıtlar, oturum kaydı bir kez daha
   * sonuna kadar okunduktan sonra "akıbeti bilinmiyor" olarak kapatılır: geri yüklenen oturumun
   * Claude süreci yenidir, önceki süreçte başlatılmış bir ajan artık çalışamaz.
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

  /** Ajan başka bir yoldan sonlandıysa (araç sonucu, oturum kapanışı) izlemeyi bırakır. */
  settle(ids: { agentId?: string; toolCallId?: string }): void {
    if (ids.toolCallId && this.entries.delete(ids.toolCallId)) {
      this.stopTimerIfIdle();
      return;
    }
    if (!ids.agentId) return;
    for (const [toolCallId, entry] of this.entries) {
      if (entry.agentId === ids.agentId) {
        this.entries.delete(toolCallId);
        break;
      }
    }
    this.stopTimerIfIdle();
  }

  async poll(): Promise<void> {
    if (this.disposed) return;
    if (this.polling) {
      // Süren yoklama dosyayı bu çağrıdan önce okumuş olabilir; bitince bir tur daha at.
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
    this.cursors.clear();
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
    this.cursors.clear();
  }

  private async pollOnce(): Promise<void> {
    const files = new Set<string>();
    const rescan = new Set<string>();
    for (const entry of [...this.entries.values()]) {
      if (!entry.sessionFile) entry.sessionFile = await this.resolveSessionFile(entry);
      if (!entry.sessionFile) continue;
      files.add(entry.sessionFile);
      if (!entry.scanned) {
        entry.scanned = true;
        rescan.add(entry.sessionFile);
      }
    }
    // Yeni eklenen bir kayıt için dosyayı baştan tara; imleç bildirimi çoktan geçmiş olabilir.
    for (const file of rescan) this.cursors.delete(file);
    const readToEnd = new Set<string>();
    for (const file of files) {
      if (this.disposed) return;
      if (await this.readAppended(file)) readToEnd.add(file);
    }
    for (const entry of [...this.entries.values()]) {
      if (entry.expireWhenScanned && entry.sessionFile && readToEnd.has(entry.sessionFile)) {
        this.expire(entry);
      }
    }
    for (const file of this.cursors.keys()) {
      if (!files.has(file)) this.cursors.delete(file);
    }
    this.stopTimerIfIdle();
  }

  private async resolveSessionFile(entry: Entry): Promise<string | null> {
    if (entry.outputFile) {
      try {
        const real = await realpath(entry.outputFile);
        const match = SUBAGENT_TRANSCRIPT_RE.exec(real);
        if (match) return join(match[1]!, `${match[2]!}.jsonl`);
      } catch {
        // Bağ henüz oluşmamış ya da geçici dizin temizlenmiş olabilir; aşağıdaki yedeklere düş.
      }
      // Yedek: `<tmp>/claude-<uid>/<slug>/<sessionId>/tasks/<agentId>.output` yolundaki slug ve
      // oturum kimliğinden Claude proje dizinini türet.
      const fallback = TASK_OUTPUT_RE.exec(entry.outputFile);
      if (fallback) {
        const candidate = join(
          this.claudeConfigDir,
          'projects',
          fallback[1]!,
          `${fallback[2]!}.jsonl`
        );
        if (await exists(candidate)) return candidate;
      }
    }
    if (entry.sessionId) {
      const bySession = await this.findSessionFile(entry.sessionId);
      if (bySession) return bySession;
    }
    entry.resolveAttempts += 1;
    if (entry.expireWhenScanned) {
      // Geri yüklenen ajanın kaydı yok (geçici dizin silinmiş, oturum kaydı taşınmış): bitişi
      // hiçbir zaman okunamayacak; "çalışıyor" bırakmak yerine akıbetini bilinmiyor say.
      this.expire(entry);
      return null;
    }
    if (entry.resolveAttempts >= MAX_RESOLVE_ATTEMPTS) {
      // Kayıt bulunamıyor; boşuna yoklamayı sürdürme. Ajan durumu diğer yollarla (araç sonucu,
      // oturum kapanışı) yine sonlandırılır.
      this.entries.delete(entry.toolCallId);
    }
    return null;
  }

  /** Oturum kaydını (projects/SLUG/SESSION.jsonl) proje dizinlerini tarayarak bulur. */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    if (!SAFE_SESSION_ID_RE.test(sessionId)) return null;
    const cached = this.sessionFiles.get(sessionId);
    if (cached) return cached;
    const projectsDir = join(this.claudeConfigDir, 'projects');
    let slugs: string[];
    try {
      slugs = await readdir(projectsDir);
    } catch {
      return null;
    }
    for (const slug of slugs) {
      const candidate = join(projectsDir, slug, `${sessionId}.jsonl`);
      if (await exists(candidate)) {
        this.sessionFiles.set(sessionId, candidate);
        return candidate;
      }
    }
    return null;
  }

  private expire(entry: Entry): void {
    if (this.entries.get(entry.toolCallId) !== entry) return;
    this.entries.delete(entry.toolCallId);
    this.onUpdate({
      kind: 'subagent_update',
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      toolCallId: entry.toolCallId,
      status: 'completed',
      statusUnknown: true,
    });
  }

  /** Dosyanın eklenen kısmını okur; dosya sonuna kadar okunduysa `true` döner. */
  private async readAppended(file: string): Promise<boolean> {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return false;
    }
    let cursor = this.cursors.get(file);
    if (!cursor || size < cursor.offset) {
      // İlk okuma ya da dosya kısalmış (yeniden yazılmış): baştan tara. Bildirim, ajan kaydı
      // yeniden yüklendiğinde (uygulama yeniden açıldığında) geçmişte kalmış olabilir.
      cursor = { offset: 0, remainder: '', decoder: new StringDecoder('utf8') };
      this.cursors.set(file, cursor);
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
      while (cursor.offset < size && !this.disposed) {
        const length = Math.min(READ_CHUNK_BYTES, size - cursor.offset);
        const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
        if (bytesRead <= 0) break;
        cursor.offset += bytesRead;
        const text = cursor.remainder + cursor.decoder.write(buffer.subarray(0, bytesRead));
        const lines = text.split('\n');
        cursor.remainder = lines.pop() ?? '';
        for (const line of lines) this.handleLine(line);
      }
    } finally {
      await handle.close();
    }
    return cursor.offset >= size && !this.disposed;
  }

  private handleLine(line: string): void {
    if (this.entries.size === 0) return;
    const text = notificationTextFromTranscriptLine(line);
    if (!text) return;
    const notification = parseTaskNotificationText(text);
    if (!notification) return;
    const status = toTerminalStatus(notification.status);
    if (!status) return;

    let entry: Entry | undefined;
    if (notification.toolUseId) entry = this.entries.get(notification.toolUseId);
    if (!entry) {
      for (const candidate of this.entries.values()) {
        // Yeniden başlatma kaydı yalnızca kendi çağrı kimliğiyle kapanır (bkz. `resume`).
        if (candidate.resume) continue;
        if (candidate.agentId === notification.taskId) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry) return;
    // Aynı görevin sonraki bildirimlerinde araç çağrısı kimliği bulunmayabilir; görev kimliğini sakla.
    entry.agentId ??= notification.taskId;
    // Ara bildirimde kaydı tut: ajan devam edip bittiğinde gelen son bildirim asıl yanıtı taşır.
    if (!notification.interim) this.entries.delete(entry.toolCallId);

    const stopped = status === 'failed' && notification.status !== 'failed';
    const summary = notification.result
      ? capResult(notification.result)
      : stopped
        ? STOPPED_SUMMARY
        : notification.summary;
    this.onUpdate({
      kind: 'subagent_update',
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      toolCallId: entry.toolCallId,
      status,
      ...(summary ? { summary } : {}),
    });
  }
}
