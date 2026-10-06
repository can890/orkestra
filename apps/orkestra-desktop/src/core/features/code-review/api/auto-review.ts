import type { ReviewScope } from './review-model';

/**
 * "Ajan turu bitince otomatik incele" kararlarının saf mantığı. Tarayıcı tarafındaki denetleyici
 * yalnızca durumu toplar; neyin ne zaman başlatılacağı burada, test edilebilir biçimde belirlenir.
 */

/** Tur bittikten sonra inceleme başlatmadan önce beklenen süre (art arda turları birleştirir). */
export const AUTO_REVIEW_DEBOUNCE_MS = 15_000;
/** Bir görevde bir saat içinde başlatılabilecek en fazla otomatik inceleme. */
export const MAX_AUTO_REVIEWS_PER_HOUR = 4;
/** Başlamış ama hiç bitmemiş görünen bir incelemenin "çalışıyor" sayılacağı en uzun süre. */
export const REVIEW_IN_FLIGHT_TIMEOUT_MS = 30 * 60_000;

const HOUR_MS = 60 * 60_000;

export type ChangeSnapshot = Readonly<{
  headOid: string | null;
  changes: ReadonlyArray<
    Readonly<{ path: string; status: string; additions: number; deletions: number }>
  >;
}>;

/** Worktree durumunun karşılaştırılabilir özeti; HEAD ya da dosya değişikliği değişince değişir. */
export function changeFingerprint(snapshot: ChangeSnapshot): string {
  const changes = [...snapshot.changes]
    .map(
      (change) =>
        `${change.path}\u0000${change.status}\u0000${change.additions}\u0000${change.deletions}`
    )
    .sort();
  return [snapshot.headOid ?? '-', ...changes].join('\u0001');
}

export type AutoReviewDecisionInput = Readonly<{
  enabled: boolean;
  /** Görevde çalışan bir inceleme var mı (bizim başlattığımız ya da çalışan bir inceleme sohbeti). */
  reviewRunning: boolean;
  /** Görevin ana konuşmalarından biri hâlâ çalışıyor mu. */
  agentWorking: boolean;
  /** Turlar başlamadan önceki parmak izi; bilinmiyorsa null. */
  fingerprintBefore: string | null;
  /** Şimdiki parmak izi; git durumu henüz bilinmiyorsa null. */
  fingerprintNow: string | null;
  /** HEAD değeri (önce/sonra karşılaştırması için). */
  headBefore: string | null;
  headNow: string | null;
  hasUncommittedChanges: boolean;
  /** En son otomatik incelenen durumun parmak izi. */
  lastReviewedFingerprint: string | null;
  /** Bu görevde başlatılan otomatik incelemelerin zaman damgaları (ms). */
  recentAutoReviews: readonly number[];
  now: number;
  preferredScope: ReviewScope;
}>;

export type AutoReviewSkipReason =
  | 'disabled'
  | 'review-running'
  | 'agent-working'
  | 'status-unknown'
  | 'no-changes'
  | 'already-reviewed'
  | 'rate-limited';

export type AutoReviewDecision =
  | { kind: 'start'; scope: ReviewScope }
  | { kind: 'skip'; reason: AutoReviewSkipReason };

/** Son bir saatteki otomatik inceleme damgalarını döndürür (eskiler atılır). */
export function pruneRecentReviews(timestamps: readonly number[], now: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < HOUR_MS);
}

/**
 * Turun ardından otomatik inceleme başlatılıp başlatılmayacağına karar verir. Kurallar:
 * ayar açık olmalı; görevde başka inceleme çalışmamalı; ajan hâlâ çalışmıyor olmalı; tur
 * gerçekten değişiklik üretmiş olmalı; aynı durum ikinci kez incelenmemeli; saatlik sınır aşılmamalı.
 */
export function decideAutoReview(input: AutoReviewDecisionInput): AutoReviewDecision {
  if (!input.enabled) return { kind: 'skip', reason: 'disabled' };
  if (input.reviewRunning) return { kind: 'skip', reason: 'review-running' };
  if (input.agentWorking) return { kind: 'skip', reason: 'agent-working' };
  if (input.fingerprintNow === null) return { kind: 'skip', reason: 'status-unknown' };
  if (input.fingerprintBefore !== null) {
    if (input.fingerprintBefore === input.fingerprintNow)
      return { kind: 'skip', reason: 'no-changes' };
  } else if (!input.hasUncommittedChanges) {
    // Tur başlangıcı bilinmiyorsa yalnızca görünür değişiklik varsa incele.
    return { kind: 'skip', reason: 'no-changes' };
  }
  if (input.lastReviewedFingerprint === input.fingerprintNow) {
    return { kind: 'skip', reason: 'already-reviewed' };
  }
  if (pruneRecentReviews(input.recentAutoReviews, input.now).length >= MAX_AUTO_REVIEWS_PER_HOUR) {
    return { kind: 'skip', reason: 'rate-limited' };
  }
  return { kind: 'start', scope: resolveAutoReviewScope(input) };
}

/**
 * Tercih edilen kapsamı duruma uyarlar: commit edilmemiş değişiklik yok ama tur commit attıysa
 * son commit incelenir.
 */
export function resolveAutoReviewScope(
  input: Pick<
    AutoReviewDecisionInput,
    'preferredScope' | 'hasUncommittedChanges' | 'headBefore' | 'headNow'
  >
): ReviewScope {
  if (
    input.preferredScope === 'uncommitted' &&
    !input.hasUncommittedChanges &&
    input.headNow !== null &&
    input.headBefore !== input.headNow
  ) {
    return 'last-commit';
  }
  return input.preferredScope;
}

export type SchedulerTimers = Readonly<{
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}>;

const defaultTimers: SchedulerTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Tur bitişlerini geciktirerek birleştirir: her yeni bitiş sayacı yeniden başlatır, yeni bir tur
 * başlaması bekleyen tetiklemeyi iptal eder. Süre dolunca `onFire` bir kez çağrılır.
 */
export class AutoReviewScheduler {
  private handle: unknown = null;
  private disposed = false;

  constructor(
    private readonly options: Readonly<{
      debounceMs: number;
      onFire: () => void;
      timers?: SchedulerTimers;
    }>
  ) {}

  get pending(): boolean {
    return this.handle !== null;
  }

  turnFinished(): void {
    if (this.disposed) return;
    this.cancel();
    const timers = this.options.timers ?? defaultTimers;
    this.handle = timers.set(() => {
      this.handle = null;
      if (!this.disposed) this.options.onFire();
    }, this.options.debounceMs);
  }

  turnStarted(): void {
    this.cancel();
  }

  cancel(): void {
    if (this.handle === null) return;
    (this.options.timers ?? defaultTimers).clear(this.handle);
    this.handle = null;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }
}
