/**
 * Bağlam devri akışı ("Sohbeti yeni bağlama taşı"): kaynak ajandan devir notu ister, notu,
 * kullanıcının mesajlarını, açık durumu ve tam döküm dosyasını tek bir pakette birleştirir; aynı
 * görevde yeni bir sohbet açar ve ilk turu bu paketle kendiliğinden başlatır.
 *
 * G/Ç portlar üzerinden yapılır (gerçek bağlama `context-handoff-runtime.ts`); böylece akış
 * sahtelerle uçtan uca test edilebilir. Aynı kaynak için ikinci tetikleme yeni sohbet açmaz,
 * süren işi döndürür.
 */
import {
  buildBriefRequestPrompt,
  chooseContextHandoffSource,
  composeContextHandoffContext,
  contextHandoffContinuePrompt,
  extractAgentBrief,
  selectUserMessagesVerbatim,
  type BriefExtraction,
  type HandoffTurnWithOutcome,
  type OpenStateSnapshot,
  type TranscriptLocation,
} from '@core/features/conversations/api/context-handoff-package';
import { buildHandoffSummary } from '@core/features/conversations/api/handoff-summary';
import type { CreateConversationParams } from '@core/primitives/conversations/api';
import { handoffTitle } from './handoff-history';
import type { HandoffRecord } from './handoff-store';

/** Kaynak ajanın devir notunu yazması için tanınan süre. Aşılırsa tur iptal edilmez. */
export const BRIEF_TIMEOUT_MS = 5 * 60_000;

export type BriefRequestResult =
  | { status: 'completed'; promptId: string }
  | { status: 'timeout'; promptId: string }
  | { status: 'not-sent'; detail?: string }
  | { status: 'aborted' };

/** Kaynak sohbetin akışa açtığı yüz. */
export interface ContextHandoffSourcePort {
  readonly conversationId: string;
  readonly projectId: string;
  readonly taskId: string;
  title(): string;
  providerId(): CreateConversationParams['provider'];
  providerLabel(): string | undefined;
  /** Kaynakta bir tur sürüyor mu. */
  isWorking(): boolean;
  /** Oturum bağlı ve istem kabul edebilir mi. */
  isUsable(): boolean;
  /** Tur bitene (ve oturum boşa düşene) kadar bekler. */
  waitUntilIdle(signal: AbortSignal): Promise<'idle' | 'aborted'>;
  /** Sıradaki mesajları kaynağın kuyruğundan alır (yeni sohbete taşınacak). */
  takeQueuedPrompts(): Promise<string[]>;
  /** Taşıma olmazsa alınan mesajları kaybolmasınlar diye kaynağın taslağına geri koyar. */
  restoreQueuedPrompts(texts: readonly string[]): void;
  /** Devir notu isteğini görünür bir mesaj olarak gönderir ve turun bitmesini bekler. */
  requestBrief(text: string, timeoutMs: number, signal: AbortSignal): Promise<BriefRequestResult>;
  /** Kaynak geçmişinin tamamı (kronolojik). Okunamazsa ekrandaki turlar. */
  loadTurns(): Promise<HandoffTurnWithOutcome[]>;
  /** Taslak, plan ve çalışan alt ajanlar (sıradaki mesajlar ayrıca alınır). */
  snapshot(): Omit<OpenStateSnapshot, 'queuedPrompts'>;
  /** Yeni sohbete kopyalanacak ayarlar (çatallama kuralı: aynı ajan, aynı otomatik onay). */
  conversationSettings(): {
    autoApprove?: boolean;
    model?: string;
    modeId?: string;
    effort?: string;
    collaborationMode?: string;
  };
}

export interface ContextHandoffEnvironment {
  newConversationId(): string;
  now(): number;
  /** Tam dökümü kaynakla aynı ana makinede, git çalışma ağacının dışına yazar. */
  writeTranscript(input: {
    newConversationId: string;
    turns: readonly HandoffTurnWithOutcome[];
  }): Promise<TranscriptLocation>;
  createConversation(params: CreateConversationParams): Promise<void>;
  /** Yeni sohbeti kaynağın yanındaki bölmede açar ve odaklar. */
  openBeside(input: { sourceConversationId: string; conversationId: string }): void;
  /** Yeni sohbetin mesaj kutusuna aktarılacak taslak. */
  setPendingDraft(conversationId: string, text: string): void;
  handoffStore: {
    get(conversationId: string): HandoffRecord | undefined;
    put(conversationId: string, record: HandoffRecord): void;
    remove(conversationId: string): void;
    findContextSuccessor(sourceConversationId: string): string | undefined;
  };
}

export type ContextHandoffPhase =
  | { kind: 'waiting-turn' }
  | { kind: 'briefing' }
  | { kind: 'packaging' }
  | { kind: 'creating' }
  | { kind: 'done'; conversationId: string; contextSource: 'agent-brief' | 'heuristic' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

export type ContextHandoffOutcome =
  | {
      kind: 'moved';
      conversationId: string;
      contextSource: 'agent-brief' | 'heuristic';
      /** Otomatik özete düşüldüyse nedeni. */
      fallbackReason?: string;
    }
  | { kind: 'already-moved'; conversationId: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

type Job = {
  phase: ContextHandoffPhase;
  controller: AbortController;
  promise: Promise<ContextHandoffOutcome>;
};

type Listener = () => void;

function isActive(phase: ContextHandoffPhase): boolean {
  return (
    phase.kind === 'waiting-turn' ||
    phase.kind === 'briefing' ||
    phase.kind === 'packaging' ||
    phase.kind === 'creating'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Kaynak sohbet başına tek bir taşıma işi tutar. Durum değişiklikleri abonelere bildirilir
 * (şerit "hazırlanıyor" durumunu buradan gösterir).
 */
export class ContextHandoffCoordinator {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<Listener>();

  phase(sourceConversationId: string): ContextHandoffPhase | undefined {
    return this.jobs.get(sourceConversationId)?.phase;
  }

  isInFlight(sourceConversationId: string): boolean {
    const phase = this.phase(sourceConversationId);
    return phase !== undefined && isActive(phase);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Taşımayı başlatır. Aynı kaynak için süren bir iş varsa onu döndürür; kaynak zaten taşınmışsa
   * yeni sohbet açmadan halefi bildirir.
   */
  start(
    source: ContextHandoffSourcePort,
    env: ContextHandoffEnvironment
  ): Promise<ContextHandoffOutcome> {
    const existing = this.jobs.get(source.conversationId);
    if (existing && isActive(existing.phase)) return existing.promise;
    const successor = env.handoffStore.findContextSuccessor(source.conversationId);
    if (successor) return Promise.resolve({ kind: 'already-moved', conversationId: successor });

    const controller = new AbortController();
    const job: Job = {
      phase: { kind: source.isWorking() ? 'waiting-turn' : 'briefing' },
      controller,
      promise: Promise.resolve({ kind: 'cancelled' }),
    };
    this.jobs.set(source.conversationId, job);
    this.emit();
    job.promise = this.run(job, source, env).then(
      (outcome) => {
        this.finish(source.conversationId, job, outcome);
        return outcome;
      },
      (error: unknown) => {
        const outcome: ContextHandoffOutcome = { kind: 'failed', message: errorMessage(error) };
        this.finish(source.conversationId, job, outcome);
        return outcome;
      }
    );
    return job.promise;
  }

  /**
   * Bekleyen ya da not yazdıran işi bırakır. Kaynaktaki tur iptal edilmez; yalnızca taşıma
   * vazgeçilir. Yeni sohbet açılmaya başladıysa geri alınamaz ve `false` döner.
   */
  cancel(sourceConversationId: string): boolean {
    const job = this.jobs.get(sourceConversationId);
    if (!job) return false;
    if (job.phase.kind !== 'waiting-turn' && job.phase.kind !== 'briefing') return false;
    job.controller.abort();
    return true;
  }

  /** Bitmiş işin durumunu unutur (şerit kapandıktan sonra). */
  clear(sourceConversationId: string): void {
    const job = this.jobs.get(sourceConversationId);
    if (!job || isActive(job.phase)) return;
    this.jobs.delete(sourceConversationId);
    this.emit();
  }

  private setPhase(job: Job, phase: ContextHandoffPhase): void {
    job.phase = phase;
    this.emit();
  }

  private finish(sourceId: string, job: Job, outcome: ContextHandoffOutcome): void {
    if (this.jobs.get(sourceId) !== job) return;
    if (outcome.kind === 'moved') {
      this.setPhase(job, {
        kind: 'done',
        conversationId: outcome.conversationId,
        contextSource: outcome.contextSource,
      });
    } else if (outcome.kind === 'failed') {
      this.setPhase(job, { kind: 'failed', message: outcome.message });
    } else {
      // İptal ya da zaten taşınmış: geride iz bırakma.
      this.jobs.delete(sourceId);
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async run(
    job: Job,
    source: ContextHandoffSourcePort,
    env: ContextHandoffEnvironment
  ): Promise<ContextHandoffOutcome> {
    const signal = job.controller.signal;
    // Sıradaki mesajlar hemen alınır: kaynakta tur bitince kendiliğinden başlamasınlar; yeni
    // sohbette devam mesajından sonra sırayla gönderilirler.
    const queued = await source.takeQueuedPrompts();
    const abandon = (): ContextHandoffOutcome => {
      source.restoreQueuedPrompts(queued);
      return { kind: 'cancelled' };
    };

    if (source.isWorking()) {
      this.setPhase(job, { kind: 'waiting-turn' });
      if ((await source.waitUntilIdle(signal)) === 'aborted') return abandon();
    }
    if (signal.aborted) return abandon();

    // 1. Devir notu: kaynak ajan bağlamın tamamını hâlâ taşıyor; notu o yazar.
    this.setPhase(job, { kind: 'briefing' });
    let extraction: BriefExtraction;
    let turns: HandoffTurnWithOutcome[] | null = null;
    if (!source.isUsable()) {
      extraction = { kind: 'failed', reason: 'source-unavailable' };
    } else {
      const request = await source.requestBrief(
        buildBriefRequestPrompt(),
        BRIEF_TIMEOUT_MS,
        signal
      );
      if (request.status === 'aborted' || signal.aborted) return abandon();
      if (request.status === 'not-sent') {
        extraction = {
          kind: 'failed',
          reason: 'not-sent',
          ...(request.detail ? { detail: request.detail } : {}),
        };
      } else {
        turns = await source.loadTurns();
        extraction =
          request.status === 'timeout'
            ? { kind: 'failed', reason: 'timeout' }
            : extractAgentBrief(turns, request.promptId);
      }
    }

    // 2. Paket: not (ya da açıkça belirtilen otomatik özet), kullanıcının mesajları, açık durum,
    // tam döküm.
    this.setPhase(job, { kind: 'packaging' });
    turns ??= await source.loadTurns();
    const title = source.title();
    const providerLabel = source.providerLabel();
    const summary = buildHandoffSummary({
      turns,
      sourceTitle: title,
      sourceProviderLabel: providerLabel,
    });
    const chosen = chooseContextHandoffSource(extraction, summary.text);
    if (!chosen) {
      source.restoreQueuedPrompts(queued);
      return { kind: 'failed', message: 'Aktarılacak sohbet geçmişi yok.' };
    }

    const newConversationId = env.newConversationId();
    const transcript = await env.writeTranscript({ newConversationId, turns }).catch(
      (error: unknown): TranscriptLocation => ({
        kind: 'unavailable',
        reason: errorMessage(error),
      })
    );
    const snapshot = source.snapshot();
    const sourceRecord = env.handoffStore.get(source.conversationId);
    const context = composeContextHandoffContext({
      sourceTitle: title,
      sourceProviderLabel: providerLabel,
      source: chosen,
      userMessages: selectUserMessagesVerbatim(turns),
      openState: { ...snapshot, queuedPrompts: queued },
      transcript,
      previousTranscriptPath:
        sourceRecord?.mode === 'context-handoff' ? sourceRecord.transcriptPath : undefined,
    });

    // 3. Yeni sohbet: aynı görev (aynı ana makine ve çalışma dizini), aynı ajan ve ayarlar.
    this.setPhase(job, { kind: 'creating' });
    env.handoffStore.put(newConversationId, {
      version: 1,
      mode: 'context-handoff',
      sourceConversationId: source.conversationId,
      sourceTitle: title,
      // Bağlam ilk kuyruk istemiyle gider; burada tekrar tutulmaz.
      context: '',
      contextDelivered: true,
      createdAt: env.now(),
      contextSource: chosen.kind,
      ...(transcript.kind === 'written' ? { transcriptPath: transcript.path } : {}),
    });
    if (snapshot.draftText.trim()) env.setPendingDraft(newConversationId, snapshot.draftText);
    const settings = source.conversationSettings();
    try {
      await env.createConversation({
        id: newConversationId,
        projectId: source.projectId,
        taskId: source.taskId,
        provider: source.providerId(),
        title: handoffTitle(title, 'context-handoff'),
        ...(settings.autoApprove !== undefined ? { autoApprove: settings.autoApprove } : {}),
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.modeId ? { modeId: settings.modeId } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings.collaborationMode ? { collaborationMode: settings.collaborationMode } : {}),
        type: 'acp',
        initialQueue: [
          { text: contextHandoffContinuePrompt(chosen), hiddenContext: context },
          ...queued.map((text) => ({ text })),
        ],
      });
    } catch (error) {
      env.handoffStore.remove(newConversationId);
      source.restoreQueuedPrompts(queued);
      return { kind: 'failed', message: errorMessage(error) };
    }
    env.openBeside({
      sourceConversationId: source.conversationId,
      conversationId: newConversationId,
    });
    return {
      kind: 'moved',
      conversationId: newConversationId,
      contextSource: chosen.kind,
      ...(chosen.kind === 'heuristic' ? { fallbackReason: chosen.failure } : {}),
    };
  }
}

let shared: ContextHandoffCoordinator | null = null;

/** Uygulama genelindeki bağlam devri işleri. */
export function getContextHandoffCoordinator(): ContextHandoffCoordinator {
  shared ??= new ContextHandoffCoordinator();
  return shared;
}
