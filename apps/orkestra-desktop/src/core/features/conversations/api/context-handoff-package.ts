/**
 * Bağlam devri paketi: kaynak ajandan istenen devir notu, notun yanıttan çıkarılması, kullanıcı
 * mesajlarının birebir taşınması ve yeni sohbete gizli bağlam olarak gidecek metnin bütçeli
 * olarak birleştirilmesi.
 *
 * Saf modüldür: G/Ç yok, saat yok, rastgelelik yok.
 */
import { clipText, type HandoffItem, type HandoffTurn } from './handoff-summary';

/** Kaynak sohbete giden devir notu isteğinin görünür ön eki (yanıtı bulmak için de kullanılır). */
export const BRIEF_REQUEST_MARKER = '[Bağlam devri]';
/** Bundan kısa devir notu yetersiz sayılır ve otomatik özete düşülür. */
export const MIN_BRIEF_CHARS = 300;

/** Gizli bağlamın toplam üst sınırı (karakter). */
export const CONTEXT_HANDOFF_BUDGET = 60_000;
/** Bölüm bütçeleri (karakter). Toplam, sabit metinlerle birlikte `CONTEXT_HANDOFF_BUDGET` içinde kalır. */
export const BRIEF_BUDGET = 26_000;
export const USER_MESSAGES_BUDGET = 22_000;
export const OPEN_STATE_BUDGET = 6_000;
/** Tek kullanıcı mesajının üst sınırı; aşan mesaj baştan ve sondan korunarak kırpılır. */
export const MAX_USER_MESSAGE_CHARS = 6_000;

/**
 * Kaynak ajana gönderilen devir notu isteği. Sohbette kullanıcı mesajı olarak görünür; gizli bir
 * talimat içermez.
 */
export function buildBriefRequestPrompt(): string {
  return [
    `${BRIEF_REQUEST_MARKER} Bu sohbetin bağlamı dolmak üzere; iş, aynı projede yeni bir sohbete taşınıyor. Yeni sohbetteki ajan bu konuşmayı göremeyecek: yalnızca şimdi yazacağın devir notunu, kullanıcının mesajlarını ve konuşmanın tam dökümünü (dosya olarak) alacak.`,
    '',
    'Şimdi işi ilerletmeden ve hiçbir dosyayı değiştirmeden, aşağıdaki başlıklarla eksiksiz bir devir notu yaz. Durumu doğrulamak gerekirse yalnızca salt okunur komutlar kullan. Tahmin yürütme; emin olmadığın şeyi "doğrulanmadı" diye işaretle.',
    '',
    '1. Amaç ve başarı ölçütü',
    '2. Kullanıcının kalıcı talimatları ve düzeltmeleri: kullanıcının kendi sözleriyle, tırnak içinde, birebir',
    '3. Alınan kararlar ve gerekçeleri',
    '4. Şu anki durum: biten işler; doğrulananlar ve doğrulanmayanlar ayrı ayrı',
    "5. Dosyalar, branch'ler, komutlar, ortamlar ve açık bıraktığın süreçler (tam yol ve adlarla)",
    '6. Kalan işler: sıralı liste, en üstte hemen atılacak ilk adım',
    '7. Tuzaklar ve kesinlikle yapılmaması gerekenler',
    '',
    'Notu tek bir yanıt olarak yaz; başka bir şey ekleme.',
  ].join('\n');
}

/** Devir notu isteğinin sohbette görünen kısa bildirimi (tam metin istenince açılır). */
export const BRIEF_REQUEST_NOTICE_LABEL = 'Bağlam devri: ajandan devir notu istendi';

/**
 * Sohbet görünümü için: devir notu isteği uygulamanın kendi gönderdiği bir mesajdır; kullanıcı
 * kartı yerine tek satırlık bildirim olarak gösterilir. Diğer kullanıcı mesajları için `null`.
 */
export function contextHandoffSystemNotice(message: { text: string }): { label: string } | null {
  return message.text.trimStart().startsWith(BRIEF_REQUEST_MARKER)
    ? { label: BRIEF_REQUEST_NOTICE_LABEL }
    : null;
}

/** Sonucu da taşıyan tur (geçmiş sayfalarındaki turlar bu alanı içerir). */
export type HandoffTurnWithOutcome = HandoffTurn & {
  outcome?: { kind: string; message?: string };
};

export type BriefFailureReason =
  | 'not-found'
  | 'error'
  | 'cancelled'
  | 'interrupted'
  | 'empty'
  | 'too-short'
  | 'timeout'
  | 'not-sent'
  | 'source-unavailable';

export type BriefExtraction =
  | { kind: 'ok'; text: string }
  | { kind: 'failed'; reason: BriefFailureReason; detail?: string };

function messageText(item: HandoffItem): string {
  return item.text?.trim() ?? '';
}

function isBriefRequestTurn(turn: HandoffTurnWithOutcome, promptId: string | undefined): boolean {
  return turn.items.some(
    (item) =>
      item.kind === 'message' &&
      item.role === 'user' &&
      ((promptId !== undefined && item.promptId === promptId) ||
        messageText(item).startsWith(BRIEF_REQUEST_MARKER))
  );
}

/**
 * Devir notunu, isteğin gittiği turdan çıkarır. Tur `promptId` ile (yoksa istek ön ekiyle, en
 * yeniden geriye) bulunur; turun tüm ajan metinleri sırayla birleştirilir. Tur hata, iptal ya da
 * kesintiyle bittiyse ya da not çok kısaysa başarısız sayılır.
 */
export function extractAgentBrief(
  turns: readonly HandoffTurnWithOutcome[],
  promptId: string | undefined
): BriefExtraction {
  let target: HandoffTurnWithOutcome | undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidate = turns[index];
    if (candidate && isBriefRequestTurn(candidate, promptId)) {
      target = candidate;
      break;
    }
  }
  if (!target) return { kind: 'failed', reason: 'not-found' };

  const outcome = target.outcome?.kind;
  if (outcome === 'error') {
    return {
      kind: 'failed',
      reason: 'error',
      ...(target.outcome?.message ? { detail: target.outcome.message } : {}),
    };
  }
  if (outcome === 'cancelled') return { kind: 'failed', reason: 'cancelled' };
  if (outcome === 'interrupted') return { kind: 'failed', reason: 'interrupted' };

  const text = target.items
    .filter((item) => item.kind === 'message' && item.role === 'assistant')
    .map(messageText)
    .filter(Boolean)
    .join('\n\n');
  if (!text) return { kind: 'failed', reason: 'empty' };
  if (text.length < MIN_BRIEF_CHARS) return { kind: 'failed', reason: 'too-short' };
  return { kind: 'ok', text };
}

/** Başarısızlık nedeninin kullanıcıya ve yeni ajana gösterilecek Türkçe açıklaması. */
export function describeBriefFailure(reason: BriefFailureReason, detail?: string): string {
  const base = {
    'not-found': 'devir notu isteğinin yanıtı bulunamadı',
    error: 'önceki ajan devir notu isteğine hatayla yanıt verdi',
    cancelled: 'devir notu turu iptal edildi',
    interrupted: 'devir notu turu yarıda kesildi',
    empty: 'önceki ajan boş yanıt verdi',
    'too-short': 'önceki ajanın yanıtı devir notu için fazla kısaydı',
    timeout: 'önceki ajan devir notunu zamanında yazamadı',
    'not-sent': 'devir notu isteği önceki sohbete gönderilemedi',
    'source-unavailable': 'önceki sohbetin oturumu bağlı değildi',
  }[reason];
  const cleanDetail = detail?.trim();
  return cleanDetail ? `${base} (${clipText(cleanDetail, 200).text})` : base;
}

export type UserMessagesSelection = {
  /** Gizli bağlama girecek bölüm metni; mesaj yoksa boş. */
  text: string;
  total: number;
  included: number;
  omitted: number;
  clipped: number;
};

/**
 * Kullanıcının kendi mesajlarını birebir taşır. En yeniden geriye bütçe dolana kadar seçilir,
 * kronolojik sırada ve numaralı yazılır. Devir notu istekleri dahil edilmez. Atlanan ya da
 * kırpılan mesajlar için açık bir not düşülür.
 */
export function selectUserMessagesVerbatim(
  turns: readonly HandoffTurn[],
  budget: number = USER_MESSAGES_BUDGET,
  perMessageCap: number = MAX_USER_MESSAGE_CHARS
): UserMessagesSelection {
  const messages: string[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind !== 'message' || item.role !== 'user') continue;
      const text = messageText(item);
      if (!text || text.startsWith(BRIEF_REQUEST_MARKER)) continue;
      messages.push(text);
    }
  }
  const total = messages.length;
  if (total === 0) return { text: '', total: 0, included: 0, omitted: 0, clipped: 0 };

  const selected: string[] = [];
  let used = 0;
  let clipped = 0;
  for (let index = total - 1; index >= 0; index -= 1) {
    const raw = messages[index] ?? '';
    const clip = clipText(raw, perMessageCap);
    const rendered = `[${index + 1}/${total}]${clip.clipped ? ' (kırpıldı)' : ''}\n${clip.text}`;
    const cost = rendered.length + 2;
    if (used + cost > budget) {
      if (selected.length > 0) break;
      // En yeni mesaj bile sığmıyorsa kırpılarak yine dahil edilir.
      const room = Math.max(200, budget - 40);
      const forced = clipText(raw, room);
      selected.unshift(`[${index + 1}/${total}] (kırpıldı)\n${forced.text}`);
      clipped += 1;
      used = budget;
      break;
    }
    if (clip.clipped) clipped += 1;
    selected.unshift(rendered);
    used += cost;
  }
  const included = selected.length;
  const omitted = total - included;
  const notes: string[] = [];
  if (omitted > 0) {
    notes.push(
      `(Toplam ${total} mesajın en yeni ${included} tanesi aşağıda. En eski ${omitted} mesaj bütçe nedeniyle alınmadı; tam metinleri döküm dosyasındadır.)`
    );
  }
  if (clipped > 0) {
    notes.push(
      `(${clipped} uzun mesaj baştan ve sondan korunarak kırpıldı; tam metinleri döküm dosyasındadır.)`
    );
  }
  return {
    text: [...notes, selected.join('\n\n')].join('\n'),
    total,
    included,
    omitted,
    clipped,
  };
}

export type ContextHandoffSource =
  | { kind: 'agent-brief'; text: string }
  | { kind: 'heuristic'; text: string; failure: string };

/**
 * Hangi kaydın taşınacağını seçer: geçerli bir devir notu varsa o, yoksa sezgisel özet (neden
 * açıkça belirtilerek). Özet de boşsa `null` (çağıran taşımayı durdurur).
 */
export function chooseContextHandoffSource(
  extraction: BriefExtraction,
  fallbackSummary: string
): ContextHandoffSource | null {
  if (extraction.kind === 'ok') return { kind: 'agent-brief', text: extraction.text };
  if (!fallbackSummary.trim()) return null;
  return {
    kind: 'heuristic',
    text: fallbackSummary,
    failure: describeBriefFailure(extraction.reason, extraction.detail),
  };
}

export type OpenStateSnapshot = {
  /** Mesaj kutusunda yazılmış ama gönderilmemiş metin. */
  draftText: string;
  /** Kaynakta sırada bekleyen mesajlar (yeni sohbete devam mesajından sonra gönderilir). */
  queuedPrompts: readonly string[];
  /** Ajanın plan/yapılacaklar listesi. */
  planEntries: readonly { content: string; status: string }[];
  /** Kaynakta hâlâ çalışan alt ajanlar ve arka plan görevleri. */
  runningAgents: readonly { name: string; detail?: string }[];
};

export type TranscriptLocation =
  | { kind: 'written'; path: string; hostLabel: string; truncated: boolean }
  | { kind: 'unavailable'; reason: string };

export type ContextHandoffContextInput = {
  sourceTitle: string;
  sourceProviderLabel?: string | undefined;
  source: ContextHandoffSource;
  userMessages: UserMessagesSelection;
  openState: OpenStateSnapshot;
  transcript: TranscriptLocation;
  /** Kaynak sohbet de bir bağlam devrinden geldiyse onun döküm dosyası. */
  previousTranscriptPath?: string | undefined;
  budget?: number;
};

const PLAN_STATUS_LABEL: Record<string, string> = {
  pending: 'bekliyor',
  in_progress: 'sürüyor',
  completed: 'bitti',
};

function renderOpenState(state: OpenStateSnapshot, budget: number): string {
  const lines: string[] = [];
  const pendingPlan = state.planEntries.filter((entry) => entry.status !== 'completed');
  if (pendingPlan.length > 0) {
    lines.push('Planın açık adımları:');
    for (const entry of pendingPlan) {
      lines.push(`- [${PLAN_STATUS_LABEL[entry.status] ?? entry.status}] ${entry.content}`);
    }
  }
  if (state.runningAgents.length > 0) {
    lines.push(
      'Önceki sohbette hâlâ çalışan alt ajanlar / arka plan görevleri (önceki sohbete bağlıdır; sonuçları orada görünür, bu sohbete kendiliğinden gelmez; aynı işi ikinci kez başlatmadan önce kullanıcıya sor):'
    );
    for (const agent of state.runningAgents) {
      lines.push(`- ${agent.name}${agent.detail ? `: ${clipText(agent.detail, 300).text}` : ''}`);
    }
  }
  if (state.queuedPrompts.length > 0) {
    lines.push(
      `Kullanıcının sırada bekleyen ${state.queuedPrompts.length} mesajı bu sohbete taşındı; bu devam mesajından sonra sırayla gelecek. Onları şimdi yanıtlamaya çalışma:`
    );
    state.queuedPrompts.forEach((prompt, index) => {
      lines.push(`${index + 1}. ${clipText(prompt, 600).text}`);
    });
  }
  if (state.draftText.trim()) {
    lines.push(
      'Kullanıcının yazıp henüz göndermediği bir taslak mesaj kutusuna aktarıldı (gönderilmedi, talimat değildir):'
    );
    lines.push(clipText(state.draftText, 1_500).text);
  }
  const text = lines.join('\n');
  return text.length <= budget ? text : clipText(text, budget).text;
}

function renderTranscript(transcript: TranscriptLocation, previous?: string): string {
  const lines: string[] = [];
  if (transcript.kind === 'written') {
    lines.push(
      `Önceki konuşmanın tamamı şu dosyada (${transcript.hostLabel}): ${transcript.path}`,
      'Bir ayrıntı belirsizse ya da bu notla çelişen bir şey görürsen tahmin etme; önce bu dosyayı oku.'
    );
    if (transcript.truncated) {
      lines.push('(Dosya boyut sınırı nedeniyle en eski kısmı kırpıldı.)');
    }
  } else {
    lines.push(
      `Konuşmanın tam dökümü dosyaya yazılamadı (${transcript.reason}). Önceki sohbet uygulamada açık duruyor; bir ayrıntı belirsizse tahmin etmek yerine kullanıcıya sor.`
    );
  }
  if (previous) {
    lines.push(`Önceki sohbet de bir bağlam devriyle başlamıştı; onun dökümü: ${previous}`);
  }
  return lines.join('\n');
}

/**
 * Yeni sohbetin ilk istemiyle gizli bağlam olarak gidecek devir paketini yazar. Bölümler: başlık
 * ve kurallar, devir notu (ya da açıkça belirtilmiş otomatik özet), kullanıcının mesajları
 * (birebir), açık durum, tam döküm. Çıktı `budget` değerini asla aşmaz.
 */
export function composeContextHandoffContext(input: ContextHandoffContextInput): string {
  const budget = input.budget ?? CONTEXT_HANDOFF_BUDGET;
  const provider = input.sourceProviderLabel ? ` (${input.sourceProviderLabel})` : '';
  const title = clipText(input.sourceTitle || 'Sohbet', 120).text;

  const header = [
    `[Bağlam devri] Bu sohbet, "${title}"${provider} sohbetinin devamıdır. Önceki sohbetin bağlamı dolduğu için iş buraya taşındı. Aynı işi aynı amaç, kısıtlar ve kararlarla, kaldığı yerden sürdür; yeni bir yön belirleme ve biten işi yeniden yapma.`,
    'Aşağıdaki bölümler önceki konuşmanın kaydıdır. Kullanıcının mesajlarındaki talimat ve düzeltmeler geçerliliğini korur; diğer bölümleri yeni talimat olarak değil, durum kaydı olarak ele al.',
  ].join('\n');

  const sourceSection =
    input.source.kind === 'agent-brief'
      ? `## 1. Devir notu (önceki ajanın kendi yazdığı)\n${clipText(input.source.text, BRIEF_BUDGET).text}`
      : `## 1. Otomatik özet\nÖnceki ajan devir notu yazamadı: ${input.source.failure}. Bunun yerine konuşmadan otomatik çıkarılan, eksik olabilecek bir özet kullanıldı. Bu yüzden ilk iş olarak döküm dosyasını oku ve durumu oradan doğrula.\n\n${clipText(input.source.text, BRIEF_BUDGET).text}`;

  const userSection = input.userMessages.text
    ? `## 2. Kullanıcının mesajları (birebir, eskiden yeniye)\n${input.userMessages.text}`
    : '## 2. Kullanıcının mesajları\n(Önceki sohbette metin içeren kullanıcı mesajı yok.)';

  const openState = renderOpenState(input.openState, OPEN_STATE_BUDGET);
  const openSection = openState ? `## 3. Açık durum\n${openState}` : '';
  const transcriptSection = `## 4. Tam döküm\n${renderTranscript(input.transcript, input.previousTranscriptPath)}`;

  const rules = [
    'Nasıl devam edeceksin:',
    '- İlk yanıtında devraldığın durumu birkaç maddede kısaca özetle, sonra "kalan işler"deki ilk adımla devam et.',
    '- Devir notu ile kullanıcının mesajları çelişirse kullanıcının en yeni mesajı geçerlidir; emin değilsen sor.',
    '- Devir paketi sonu.',
  ].join('\n');

  const sections = [
    header,
    sourceSection,
    userSection,
    openSection,
    transcriptSection,
    rules,
  ].filter(Boolean);
  let text = sections.join('\n\n');
  if (text.length <= budget) return text;

  // Güvenlik ağı: önce kullanıcı mesajları, sonra not kırpılır; başlık, döküm ve kurallar korunur.
  const fixed = [header, openSection, transcriptSection, rules].filter(Boolean).join('\n\n');
  const room = Math.max(400, budget - fixed.length - 8);
  const sourceRoom = Math.floor(room * 0.55);
  const userRoom = room - sourceRoom;
  text = [
    header,
    clipText(sourceSection, sourceRoom).text,
    clipText(userSection, userRoom).text,
    openSection,
    transcriptSection,
    rules,
  ]
    .filter(Boolean)
    .join('\n\n');
  return text.length <= budget ? text : clipText(text, budget).text;
}

const CONTINUE_PROMPT =
  'Önceki sohbetten taşınan işe kaldığın yerden devam et; önce devraldığın durumu kısaca özetle.';

/** Yeni sohbette görünen ilk mesaj (gizli bağlam bununla birlikte gider). */
export function contextHandoffContinuePrompt(source: ContextHandoffSource): string {
  return source.kind === 'agent-brief'
    ? CONTINUE_PROMPT
    : `${CONTINUE_PROMPT} (Önceki ajan devir notu yazamadı: ${source.failure}; otomatik özet ve tam döküm kullanılıyor.)`;
}

/**
 * Metin bağlam devrinin kendiliğinden gönderdiği bir istem mi (kaynağa giden devir notu isteği ya
 * da yeni sohbetin ilk devam mesajı)? Bunlar kullanıcının sözü değildir: görev ya da sohbet
 * başlığı bunlardan türetilmez.
 */
export function isContextHandoffSystemPrompt(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trimStart();
  return trimmed.startsWith(BRIEF_REQUEST_MARKER) || trimmed.startsWith(CONTINUE_PROMPT);
}

/** Döküm dosyasının boyut sınırı (dosya yükleme sınırının altında kalır). */
export const MAX_TRANSCRIPT_BYTES = 9 * 1024 * 1024;

/**
 * Döküm metnini boyut sınırına sığdırır; gerekirse en eski kısmı atar ve başa not koyar.
 * Sınır karakter olarak uygulanır (UTF-8'de bir karakter en fazla 4 bayttır).
 */
export function fitTranscript(
  markdown: string,
  maxBytes: number = MAX_TRANSCRIPT_BYTES
): { text: string; truncated: boolean } {
  const maxChars = Math.floor(maxBytes / 4);
  if (markdown.length <= maxChars) return { text: markdown, truncated: false };
  const note = '> Not: Döküm boyut sınırı nedeniyle en eski kısmı kırpıldı.\n\n';
  return { text: `${note}${markdown.slice(-(maxChars - note.length))}`, truncated: true };
}

/** Döküm dosyasının konumu: kullanıcının ev dizininde, git çalışma ağacının dışında. */
export function contextHandoffTranscriptDir(homeDirectory: string): string {
  const separator = homeDirectory.includes('\\') && !homeDirectory.includes('/') ? '\\' : '/';
  const base = homeDirectory.replace(/[\\/]+$/, '');
  return [base, '.orkestra', 'handoffs'].join(separator);
}

export function contextHandoffTranscriptFileName(newConversationId: string): string {
  return `${newConversationId}.md`;
}
