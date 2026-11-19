import { comparer, makeAutoObservable, reaction } from 'mobx';
import {
  appendEvent,
  applyBaseline,
  applyTrigger,
  buildAutoFixPrompt,
  decideAutoFix,
  describeSkipReason,
  emptyLedger,
  isBlockingReason,
  ledgerForPr,
  summarizeTrigger,
  type AgentAvailability,
  type AutoFixComment,
  type AutoFixDecision,
  type AutoFixPr,
  type PrAutomationEvent,
  type PrAutomationState,
} from '../../pr-automation';

/** Memento tutamağının bu store'un kullandığı dar yüzü (testte sahtesi yazılır). */
export type PrAutomationHandle = {
  readonly value: PrAutomationState;
  readonly ready: Promise<void>;
  update(next: (current: PrAutomationState) => PrAutomationState): void;
};

export type PrAutomationSnapshot = {
  pr: AutoFixPr;
  comments: { fetched: boolean; items: readonly AutoFixComment[] };
};

export type PrAutomationPorts = {
  handle: PrAutomationHandle;
  /** Mevcut PR + yorumlar (mevcut motor yenileme akışının canlı modelinden); bilinmiyorsa null. */
  read: () => PrAutomationSnapshot | null;
  agent: () => AgentAvailability;
  sendPrompt: (text: string) => Promise<{ success: true } | { success: false; error: string }>;
  now?: () => number;
  /** Kullanıcıya görünen bildirimler ve günlük. */
  report: {
    sent: (summary: string) => void;
    failed: (summary: string, error: string) => void;
    blocked: (message: string) => void;
  };
};

/**
 * Görev başına PR otomasyonu: "Otomatik düzelt" anahtarı + korkuluk defteri. Yeni bir GitHub
 * yoklaması başlatmaz; PrStore'un canlı `details` modelini (motorun yenileme akışı) izler ve
 * her değişimde saf `decideAutoFix` kararına uyar. Karar tetikleme ise deftere ÖNCE yazılır,
 * sonra gönderilir: gönderim başarısız olsa bile deneme harcanır (tekrar denemeyle döngü olmaz).
 */
export class PrAutomationStore {
  private disposeReaction: (() => void) | null = null;
  private disposed = false;
  private sending = false;
  private lastBlockedKey: string | null = null;

  constructor(private readonly ports: PrAutomationPorts) {
    makeAutoObservable<
      this,
      'ports' | 'disposeReaction' | 'disposed' | 'sending' | 'lastBlockedKey'
    >(this, {
      ports: false,
      disposeReaction: false,
      disposed: false,
      sending: false,
      lastBlockedKey: false,
    });
  }

  get state(): PrAutomationState {
    return this.ports.handle.value;
  }

  get autoFix(): boolean {
    return this.state.autoFix;
  }

  get events(): readonly PrAutomationEvent[] {
    return this.state.events;
  }

  /** Kullanıcı bu PR için auto-merge isteği açtıysa stratejisi; aksi halde null. */
  autoMergeStrategyFor(prUrl: string) {
    const autoMerge = this.state.autoMerge;
    return autoMerge && autoMerge.prUrl === prUrl ? autoMerge.strategy : null;
  }

  /** Yalnızca kullanıcının açık tıklamasından çağrılır. Açmak defteri sıfırlar (yeniden silahlanma). */
  setAutoFix(enabled: boolean): void {
    this.ports.handle.update((current) => ({
      ...current,
      autoFix: enabled,
      ledger: enabled ? emptyLedger(current.ledger.prUrl) : current.ledger,
    }));
    this.lastBlockedKey = null;
  }

  setAutoMergeIntent(
    intent: { prUrl: string; strategy: 'merge' | 'squash' | 'rebase' } | null
  ): void {
    this.ports.handle.update((current) => ({ ...current, autoMerge: intent }));
  }

  /** Kalıcı durum yüklendikten sonra izlemeyi başlatır (öncesinde varsayılan "kapalı" geçerlidir). */
  start(): void {
    void this.ports.handle.ready.then(() => {
      if (this.disposed || this.disposeReaction) return;
      this.disposeReaction = reaction(
        () => this.evaluate(),
        (outcome) => {
          if (outcome) void this.apply(outcome);
        },
        { fireImmediately: true, equals: comparer.structural }
      );
    });
  }

  private evaluate(): { decision: AutoFixDecision; pr: AutoFixPr } | null {
    const snapshot = this.ports.read();
    if (!snapshot) return null;
    const decision = decideAutoFix({
      enabled: this.state.autoFix,
      pr: snapshot.pr,
      comments: snapshot.comments,
      agent: this.ports.agent(),
      ledger: this.state.ledger,
    });
    return { decision, pr: snapshot.pr };
  }

  private async apply(outcome: { decision: AutoFixDecision; pr: AutoFixPr }): Promise<void> {
    const { decision, pr } = outcome;
    if (decision.action === 'baseline') {
      this.ports.handle.update((current) => ({
        ...current,
        ledger: applyBaseline(current.ledger, pr.url, decision.commentIds),
      }));
      return;
    }
    if (decision.action === 'skip') {
      this.noteSkip(decision.reason, pr);
      return;
    }
    if (this.sending || this.disposed) return;
    this.sending = true;
    try {
      const now = (this.ports.now ?? Date.now)();
      const summary = summarizeTrigger(decision);
      // Önce deftere yaz: gönderim yarıda kalsa da aynı hata ikinci kez işlenmez.
      this.ports.handle.update((current) => ({
        ...current,
        ledger: applyTrigger(ledgerForPr(current.ledger, pr.url), pr.url, pr.headRefOid, decision),
      }));
      this.lastBlockedKey = null;
      const result = await this.ports.sendPrompt(buildAutoFixPrompt(pr, decision));
      this.recordEvent({
        at: now,
        kind: result.success ? 'sent' : 'send-failed',
        headSha: pr.headRefOid,
        summary: result.success ? summary : `${summary}: ${result.error}`,
      });
      if (result.success) this.ports.report.sent(summary);
      else this.ports.report.failed(summary, result.error);
    } finally {
      this.sending = false;
    }
  }

  private noteSkip(reason: Parameters<typeof describeSkipReason>[0], pr: AutoFixPr): void {
    if (!isBlockingReason(reason)) return;
    // Sınıra ulaşıldığını bir kez bildir (ayni head için tekrar etme).
    const key = `${reason}:${pr.url}:${pr.headRefOid}`;
    if (this.lastBlockedKey === key) return;
    this.lastBlockedKey = key;
    const message = describeSkipReason(reason);
    this.recordEvent({
      at: (this.ports.now ?? Date.now)(),
      kind: 'blocked',
      headSha: pr.headRefOid,
      summary: message,
    });
    this.ports.report.blocked(message);
  }

  private recordEvent(event: PrAutomationEvent): void {
    this.ports.handle.update((current) => ({
      ...current,
      events: appendEvent(current.events, event),
    }));
  }

  dispose(): void {
    this.disposed = true;
    this.disposeReaction?.();
    this.disposeReaction = null;
  }
}
