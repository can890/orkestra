import type { PromptSuggestionInput } from '@/core/conversation-session';
import type { SessionActivityView, TranscriptEntry } from '@/core/mappers';
import type { MobileDisplayRow } from '@/core/turn-fold';

export function isElicitationAnswerEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'message' &&
    entry.role === 'user' &&
    (entry.isElicitationAnswer === true || entry.id.startsWith('elicit-'))
  );
}

export function isTurnBoundaryUserEntry(entry: TranscriptEntry): boolean {
  return entry.kind === 'message' && entry.role === 'user' && !isElicitationAnswerEntry(entry);
}

/**
 * Aktif turda satır içi çalışan bir gösterge (`thinking` aktif ya da `tool` çalışıyor) var mı?
 * `kind === 'plan'` canlı "Düşünüyor" satırını asla bastırmaz.
 */
export function hasActiveWorkingEntry(entry: TranscriptEntry): boolean {
  if (entry.kind === 'thinking') return entry.active === true;
  if (entry.kind === 'plan') return false;
  if (entry.kind === 'tool') {
    return entry.status === 'running' || entry.children.some(hasActiveWorkingEntry);
  }
  return false;
}

export function getActiveTurnEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  if (entries.length === 0) return [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isTurnBoundaryUserEntry(entries[i]!)) {
      return entries.slice(i);
    }
  }
  return [...entries];
}

/**
 * Canlı `••• Düşünüyor` çalışma satırı gösterilmeli mi?
 * Aktif `thinking` ya da çalışan `tool` varsa çift gösterge basmaz; `kind === 'plan'`
 * veya boş transkriptte yeni gönderilmiş mesaj varken çalışmayı bastırmaz.
 */
export function shouldShowMobileWorkingIndicator(
  entries: readonly TranscriptEntry[],
  isWorking: boolean
): boolean {
  if (!isWorking) return false;
  const activeTurn = getActiveTurnEntries(entries);
  if (activeTurn.some(hasActiveWorkingEntry)) return false;
  return true;
}

/**
 * Aktif turda `kind === 'plan'` kartını her zaman en alttaki canlı düşünme/çalışma
 * satırının hemen üstüne taşır; uzun turlarda plan kartı yukarıda kaybolmaz.
 */
export function positionActivePlanRows(
  rows: readonly MobileDisplayRow[],
  isWorking: boolean
): MobileDisplayRow[] {
  if (!isWorking || rows.length === 0) return [...rows];

  let activeStart = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.kind === 'entry' && isTurnBoundaryUserEntry(row.entry)) {
      activeStart = i;
      break;
    }
  }

  const prefix = rows.slice(0, activeStart);
  const activeSlice = rows.slice(activeStart);
  const plans: MobileDisplayRow[] = [];
  const rest: MobileDisplayRow[] = [];

  for (const row of activeSlice) {
    if (row.kind === 'entry' && row.entry.kind === 'plan') {
      plans.push(row);
    } else {
      rest.push(row);
    }
  }

  if (plans.length === 0) return [...rows];

  let insertAt = rest.length;
  while (insertAt > 0) {
    const prev = rest[insertAt - 1]!;
    const isTrailingActiveThinking =
      prev.kind === 'entry' && prev.entry.kind === 'thinking' && prev.entry.active;
    if (!isTrailingActiveThinking) break;
    insertAt -= 1;
  }

  return [...prefix, ...rest.slice(0, insertAt), ...plans, ...rest.slice(insertAt)];
}

/**
 * Aktif turun gerçek başlangıç zamanını bulur (sohbete girip çıkınca sayaç sıfırlanmaz).
 */
export function extractActiveTurnStartedAt(
  entries: readonly TranscriptEntry[],
  activity: SessionActivityView | null | undefined
): number | null {
  if (
    activity &&
    typeof activity.turnStartedAt === 'number' &&
    Number.isFinite(activity.turnStartedAt) &&
    activity.turnStartedAt > 0
  ) {
    return activity.turnStartedAt;
  }

  const activeTurn = getActiveTurnEntries(entries);
  for (const entry of activeTurn) {
    if (
      typeof entry.turnStartedAt === 'number' &&
      Number.isFinite(entry.turnStartedAt) &&
      entry.turnStartedAt > 0
    ) {
      return entry.turnStartedAt;
    }
  }
  for (const entry of activeTurn) {
    if (
      entry.kind === 'thinking' &&
      typeof entry.startedAt === 'number' &&
      Number.isFinite(entry.startedAt) &&
      entry.startedAt > 0
    ) {
      return entry.startedAt;
    }
  }
  for (const entry of activeTurn) {
    if (
      entry.kind === 'message' &&
      typeof entry.createdAt === 'number' &&
      Number.isFinite(entry.createdAt) &&
      entry.createdAt > 0
    ) {
      return entry.createdAt;
    }
  }
  return null;
}

const MAX_ASSISTANT_HEAD_CHARS = 1200;
const MAX_ASSISTANT_TAIL_CHARS = 2600;
const MAX_ASSISTANT_TOTAL_CHARS = 4200;

function truncateAssistantHeadTail(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.length <= MAX_ASSISTANT_TOTAL_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_ASSISTANT_HEAD_CHARS)}\n…\n${trimmed.slice(-MAX_ASSISTANT_TAIL_CHARS)}`;
}

export interface MobilePromptSuggestionContext {
  signature: string;
  input: Omit<PromptSuggestionInput, 'projectName' | 'taskName'>;
}

/**
 * Masaüstü `extractPromptSuggestionContext` ile aynı imza ve bağlam yapısını mobil
 * `TranscriptEntry[]` listesinden çıkarır.
 */
export function extractMobilePromptSuggestionContext(
  entries: readonly TranscriptEntry[],
  conversationId: string,
  lastTurnErrored = false
): MobilePromptSuggestionContext | null {
  if (entries.length === 0) return null;
  const turnEntries = getActiveTurnEntries(entries);
  if (turnEntries.length === 0) return null;

  const assistantChunks: string[] = [];
  const editedFilesSet = new Set<string>();
  const executedCommands: Array<{ command: string; failed?: boolean }> = [];
  let readFilesCount = 0;
  let createdPlan = false;
  let failedToolsCount = 0;
  let outcome: 'done' | 'cancelled' | 'error' | 'interrupted' | undefined;

  const visitEntry = (entry: TranscriptEntry) => {
    if (entry.kind === 'message' && entry.role === 'assistant' && entry.text.trim()) {
      assistantChunks.push(entry.text.trim());
    } else if (entry.kind === 'plan') {
      createdPlan = true;
    } else if (entry.kind === 'notice') {
      if (entry.tone === 'error') {
        outcome = 'error';
      } else if (entry.text.toLowerCase().includes('iptal')) {
        outcome = 'cancelled';
      } else if (entry.text.toLowerCase().includes('kesinti')) {
        outcome = 'interrupted';
      }
    } else if (entry.kind === 'tool') {
      switch (entry.toolKind) {
        case 'create-file-tool-call':
        case 'modify-file-tool-call':
        case 'delete-file-tool-call': {
          const target = entry.detail || entry.locations?.[0];
          if (target?.trim()) editedFilesSet.add(target.trim());
          if (entry.status === 'failed') failedToolsCount += 1;
          break;
        }
        case 'read-tool-call': {
          readFilesCount += 1;
          if (entry.status === 'failed') failedToolsCount += 1;
          break;
        }
        case 'execute-tool-call': {
          const cmd = (entry.detail || entry.title).replace(/\s+/g, ' ').trim();
          if (cmd) {
            executedCommands.push({
              command: cmd.slice(0, 400),
              ...(entry.status === 'failed' ? { failed: true } : {}),
            });
          }
          if (entry.status === 'failed') failedToolsCount += 1;
          break;
        }
        default: {
          if (entry.toolKind !== 'tool-group' && entry.status === 'failed') {
            failedToolsCount += 1;
          }
          break;
        }
      }
      for (const child of entry.children) {
        visitEntry(child);
      }
    }
  };

  for (const entry of turnEntries) {
    visitEntry(entry);
  }

  if (!outcome && lastTurnErrored) {
    outcome = 'error';
  }

  const isUnfinishedOrFailed =
    outcome === 'cancelled' || outcome === 'error' || outcome === 'interrupted';
  if (assistantChunks.length === 0 && !isUnfinishedOrFailed) {
    return null;
  }

  let lastUserText: string | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const item = entries[i]!;
    if (isTurnBoundaryUserEntry(item) && item.kind === 'message' && item.text.trim()) {
      lastUserText = item.text.trim().slice(0, 2000);
      break;
    }
  }

  const editedFiles = [...editedFilesSet].slice(0, 30);
  const recentCommands = executedCommands.slice(-20);
  const lastAssistantText = truncateAssistantHeadTail(assistantChunks.join('\n\n'));
  const anchorId = turnEntries[0]!.id;
  const tailId = turnEntries[turnEntries.length - 1]!.id;
  const signature = `${conversationId}:${anchorId}:${tailId}:${outcome ?? 'done'}:${lastAssistantText.length}:${editedFiles.length}:${recentCommands.length}`;

  return {
    signature,
    input: {
      ...(lastUserText ? { lastUserText } : {}),
      lastAssistantText,
      activity: {
        ...(outcome ? { outcome } : {}),
        ...(editedFiles.length > 0 ? { editedFiles } : {}),
        ...(readFilesCount > 0 ? { readFilesCount } : {}),
        ...(recentCommands.length > 0 ? { executedCommands: recentCommands } : {}),
        ...(createdPlan ? { createdPlan: true } : {}),
        ...(failedToolsCount > 0 ? { failedToolsCount } : {}),
      },
    },
  };
}

export function stopReasonBannerText(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'max_tokens':
      return 'Yanıt maksimum token sınırına ulaştığı için kesildi.';
    case 'max_turn_requests':
      return 'Tur başına maksimum istek sınırına ulaşıldı.';
    case 'refusal':
      return 'Model bu isteği güvenlik politikası nedeniyle reddetti.';
    default:
      return null;
  }
}
