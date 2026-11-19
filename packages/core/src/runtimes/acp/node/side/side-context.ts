import type { ToolNode, TranscriptItem, TranscriptTurn } from '#runtimes/acp/api';

export interface SideContextHistory {
  committed: readonly TranscriptTurn[];
  active: TranscriptTurn | null;
}

export interface SideContextOptions {
  /** Upper bound for the rendered context; the newest text wins. */
  maxChars?: number;
  /** How many committed turns (before the active one) to include. */
  recentTurns?: number;
}

export const SIDE_CONTEXT_MAX_CHARS = 12_000;
const DEFAULT_RECENT_TURNS = 3;
const TRUNCATION_NOTE = '(önceki kısım kısaltıldı)';

const TOOL_STATUS_TR = { running: 'çalışıyor', done: 'bitti', error: 'hata' } as const;

/**
 * Compact text rendering of the main session for the side-answer prompt: user and assistant text of
 * the last few committed turns, then the active turn with its tool calls (title + status). Side
 * exchanges are left out because the main agent never saw them. Oldest lines are dropped first.
 */
export function buildSideContext(
  history: SideContextHistory,
  options: SideContextOptions = {}
): string {
  const maxChars = options.maxChars ?? SIDE_CONTEXT_MAX_CHARS;
  const recent = history.committed.slice(-(options.recentTurns ?? DEFAULT_RECENT_TURNS));
  const lines: string[] = [];
  for (const turn of recent) lines.push(...turnLines(turn, false));
  if (history.active) lines.push(...turnLines(history.active, true));
  return fitNewest(lines, maxChars);
}

function turnLines(turn: TranscriptTurn, includeTools: boolean): string[] {
  const lines: string[] = [];
  for (const item of turn.items) lines.push(...itemLines(item, includeTools));
  return lines;
}

function itemLines(item: TranscriptItem, includeTools: boolean): string[] {
  if (item.kind === 'message') {
    if (item.side || !item.text.trim()) return [];
    return [`${item.role === 'user' ? 'Kullanıcı' : 'Ajan'}: ${item.text.trim()}`];
  }
  if (item.kind === 'thinking' || !includeTools) return [];
  return toolLines(item);
}

function toolLines(node: ToolNode): string[] {
  if (node.kind === 'tool-group') return node.children.flatMap(toolLines);
  const own = `[araç] ${node.title} — ${TOOL_STATUS_TR[node.status]}`;
  return [own, ...(node.children ?? []).flatMap(toolLines)];
}

function fitNewest(lines: readonly string[], maxChars: number): string {
  const kept: string[] = [];
  let size = 0;
  let truncated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const cost = line.length + 1;
    if (size + cost > maxChars) {
      const room = maxChars - size - 2;
      // Keep the tail of an oversized line only when nothing newer fills the budget yet.
      if (kept.length === 0 && room > 0) kept.push(`…${line.slice(line.length - room)}`);
      truncated = true;
      break;
    }
    kept.push(line);
    size += cost;
  }
  kept.reverse();
  const body = kept.join('\n');
  return truncated ? `${TRUNCATION_NOTE}\n${body}` : body;
}

export function buildSidePrompt(context: string, question: string): string {
  return [
    'Sen, başka bir kodlama ajanının çalışmasını izleyen yardımcı bir asistansın. Ana ajan şu anda',
    'çalışmaya devam ediyor; sen onun adına iş yapmıyorsun.',
    'Kurallar: Hiçbir araç kullanma, hiçbir dosyaya dokunma, komut çalıştırma. Soruyu yalnızca aşağıdaki',
    'bağlama dayanarak kısa ve net yanıtla. Bağlam yetersizse bunu açıkça söyle; tahmin yürütme.',
    '',
    '--- Ana ajanın oturumundan bağlam ---',
    context.trim() || '(henüz bağlam yok)',
    '--- Bağlamın sonu ---',
    '',
    `Kullanıcının sorusu: ${question.trim()}`,
  ].join('\n');
}
