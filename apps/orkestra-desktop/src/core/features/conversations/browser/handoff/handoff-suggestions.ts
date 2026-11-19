import type { UsageCapacityStatus } from '@core/features/usage-limits/api/usage-capacity';

/**
 * "Başka ajanla devam et" için saf kararlar: hangi ajanlar aday, hangi sırayla önerilir, limit
 * şeridi ne zaman görünür. G/Ç, saat ve React yoktur; zaman dışarıdan (`now`) verilir.
 */

/** Devir adayı olabilecek bir ajanın sade görünümü. */
export type HandoffAgentInfo = {
  id: string;
  name: string;
  /** Sohbet arayüzünü (ACP) destekliyor mu. */
  supportsAcp: boolean;
};

/** Bir ajanın kullanım kapasitesinin devir kararı için gereken kısmı. */
export type HandoffCapacity = {
  status: UsageCapacityStatus;
  /** Bağlayıcı pencerenin yenilenme zamanı (ISO), biliniyorsa. */
  resetsAt?: string | undefined;
};

export type HandoffCapacities = Readonly<Record<string, HandoffCapacity | undefined>>;

/** Şeritte gösterilen en fazla öneri düğmesi sayısı. */
export const MAX_SUGGESTION_BUTTONS = 3;
/** Yenilenme zamanı bilinmiyorsa şeridin kapatılma süresi (Claude/Kimi gibi 5 saatlik pencere). */
export const DEFAULT_LIMIT_WINDOW_MS = 5 * 60 * 60_000;
/** Yenilenme zamanındaki küçük sapmalar aynı pencere sayılsın diye anahtar bu aralığa yuvarlanır. */
const RESET_KEY_BUCKET_MS = 10 * 60_000;

// ── Adaylar ──────────────────────────────────────────────────────────────────

/**
 * Devredilebilecek ajanlar: mevcut ajan hariç, ACP destekleyen ve (durum biliniyorsa) kurulu
 * olanlar. `installedIds` verilmezse kurulum durumu henüz bilinmiyor demektir ve süzülmez;
 * "Başka ajana devret" penceresinin kullandığı kural da budur.
 */
export function listHandoffCandidates(input: {
  agents: readonly HandoffAgentInfo[];
  installedIds: readonly string[] | undefined;
  currentProviderId: string | null | undefined;
}): HandoffAgentInfo[] {
  const installed = input.installedIds ? new Set(input.installedIds) : null;
  return input.agents.filter(
    (agent) =>
      agent.id !== input.currentProviderId &&
      agent.supportsAcp &&
      (installed === null || installed.has(agent.id))
  );
}

// ── Sıralama ─────────────────────────────────────────────────────────────────

const STATUS_RANK: Record<UsageCapacityStatus, number> = {
  ok: 0,
  tight: 1,
  unknown: 2,
  saturated: 3,
};

function statusOf(capacities: HandoffCapacities, id: string): UsageCapacityStatus {
  return capacities[id]?.status ?? 'unknown';
}

/** Adayları kapasiteye göre dizer: ok, tight, unknown, saturated; eşitlikte giriş sırası korunur. */
export function sortHandoffCandidates<T extends { id: string }>(
  candidates: readonly T[],
  capacities: HandoffCapacities
): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        STATUS_RANK[statusOf(capacities, a.candidate.id)] -
          STATUS_RANK[statusOf(capacities, b.candidate.id)] || a.index - b.index
    )
    .map(({ candidate }) => candidate);
}

export type HandoffSuggestion = HandoffAgentInfo & { status: UsageCapacityStatus };

export type HandoffSuggestions = {
  /** Şeritteki düğmeler; kapasitesi dolu olanlar burada asla yer almaz. */
  buttons: HandoffSuggestion[];
  /** Düğmeye sığmayan (dolu olanlar dahil) aday sayısı; > 0 ise "Diğerleri…" gösterilir. */
  moreCount: number;
};

/** Şerit önerileri: en fazla 3 düğme (dolu olmayanlardan, ok → tight → unknown) + diğerleri. */
export function suggestHandoffAgents(
  candidates: readonly HandoffAgentInfo[],
  capacities: HandoffCapacities,
  maxButtons: number = MAX_SUGGESTION_BUTTONS
): HandoffSuggestions {
  const ranked = sortHandoffCandidates(candidates, capacities).map((agent) => ({
    ...agent,
    status: statusOf(capacities, agent.id),
  }));
  const buttons = ranked.filter((agent) => agent.status !== 'saturated').slice(0, maxButtons);
  return { buttons, moreCount: ranked.length - buttons.length };
}

// ── Rozet ────────────────────────────────────────────────────────────────────

export type HandoffAgentBadge = {
  label: string;
  tone: 'warning' | 'danger';
  title: string;
};

/** Yenilenmeye kalan süre: "45 dk", "2 sa 15 dk", "3 gün"; bilinmiyorsa ya da geçmişse null. */
export function formatResetIn(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const time = new Date(resetsAt).getTime();
  if (!Number.isFinite(time) || time <= now) return null;
  const minutes = Math.max(1, Math.round((time - now) / 60_000));
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} sa ${minutes % 60} dk` : `${hours} sa`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} gün ${hours % 24} sa` : `${days} gün`;
}

/** Ajan satırındaki kısa kullanım rozeti; ok/unknown için rozet yoktur. */
export function agentUsageBadge(
  capacity: HandoffCapacity | undefined,
  now: number
): HandoffAgentBadge | null {
  if (capacity?.status === 'saturated') {
    const reset = formatResetIn(capacity.resetsAt, now);
    return {
      label: 'limit doldu',
      tone: 'danger',
      title: reset ? `Kullanım limiti doldu; ${reset} sonra yenilenir.` : 'Kullanım limiti doldu.',
    };
  }
  if (capacity?.status === 'tight') {
    return { label: 'az kaldı', tone: 'warning', title: 'Kullanım limiti dolmak üzere.' };
  }
  return null;
}

// ── Limit hatası ─────────────────────────────────────────────────────────────

/**
 * Bir turun hata iletisinin kullanım/oran limitini gösterip göstermediği. Ajan çalışma zamanı
 * (`prompt-error-tr.ts`) limit hatalarını "kullanım limiti doldu" metnine çevirir; çevrilmemiş
 * sağlayıcı iletileri de aynı örüntülerle yakalanır.
 */
export function isUsageLimitMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /kullanım limiti doldu|quota reached|quota exceeded|resource_exhausted|usage limit|rate limit|too many requests|\b429\b/i.test(
    message
  );
}

/** Turun hata sonucu limit kaynaklıysa tur kimliğini, değilse null döner. */
export function limitErrorTurnId(
  turn:
    | { id: string; outcome?: { kind: string; message?: string | undefined } | undefined }
    | null
    | undefined
): string | null {
  if (!turn?.outcome || turn.outcome.kind !== 'error') return null;
  return isUsageLimitMessage(turn.outcome.message) ? turn.id : null;
}

// ── Limit şeridi ─────────────────────────────────────────────────────────────

/** Kapatılan bir şeridin kaydı; `expiresAt`e kadar aynı anahtar için şerit yeniden çıkmaz. */
export type LimitDismissal = { key: string; expiresAt: number };

export type LimitSignal = {
  kind: 'saturated' | 'turn-error';
  /** Aynı limit olayını tanıyan kararlı anahtar. */
  key: string;
  resetsAt?: string | undefined;
};

export type LimitBannerInput = {
  providerId: string;
  /** Sohbetin ajanının kapasitesi; bilinmiyorsa undefined. */
  capacity: HandoffCapacity | undefined;
  /** Son tur limit hatasıyla bittiyse o turun kimliği. */
  limitErrorTurnId: string | null;
  dismissals: readonly LimitDismissal[];
  now: number;
};

export type LimitBannerDecision =
  | { show: false }
  | {
      show: true;
      reason: 'saturated' | 'turn-error';
      /** Biliniyorsa limitin yenilenme zamanı (ISO). */
      resetsAt?: string | undefined;
      /** Kapatılınca kaydedilecek tüm güncel sinyaller. */
      signals: readonly LimitSignal[];
    };

/** Şeridi tetikleyen güncel sinyaller: kapasite dolu ve/veya son tur limit hatasıyla bitti. */
export function currentLimitSignals(
  input: Pick<LimitBannerInput, 'providerId' | 'capacity' | 'limitErrorTurnId'>
): LimitSignal[] {
  const signals: LimitSignal[] = [];
  if (input.capacity?.status === 'saturated') {
    const reset = input.capacity.resetsAt ? new Date(input.capacity.resetsAt).getTime() : NaN;
    const bucket = Number.isFinite(reset)
      ? String(Math.round(reset / RESET_KEY_BUCKET_MS))
      : 'unknown';
    signals.push({
      kind: 'saturated',
      key: `saturated:${input.providerId}:${bucket}`,
      resetsAt: input.capacity.resetsAt,
    });
  }
  if (input.limitErrorTurnId) {
    signals.push({ kind: 'turn-error', key: `turn-error:${input.limitErrorTurnId}` });
  }
  return signals;
}

/**
 * Limit şeridi görünür mü? Görünür olması için bir sinyal olmalı ve o sinyalin anahtarı
 * (süresi dolmamış) bir kapatma kaydıyla örtüşmemeli. Pencere yenilenince doluluk sinyali
 * kendiliğinden düşer; yeni bir doluluk yeni bir `resetsAt` ve dolayısıyla yeni anahtar taşır.
 */
export function decideLimitBanner(input: LimitBannerInput): LimitBannerDecision {
  const signals = currentLimitSignals(input);
  const visible = signals.filter(
    (signal) =>
      !input.dismissals.some(
        (dismissal) => dismissal.key === signal.key && dismissal.expiresAt > input.now
      )
  );
  const first = visible[0];
  if (!first) return { show: false };
  return {
    show: true,
    reason: first.kind,
    resetsAt: signals.find((signal) => signal.kind === 'saturated')?.resetsAt,
    signals,
  };
}

/** Şerit kapatılırken saklanacak kayıtlar: pencere yenilenene (bilinmiyorsa 5 saate) kadar. */
export function dismissalsFor(signals: readonly LimitSignal[], now: number): LimitDismissal[] {
  return signals.map((signal) => {
    const reset = signal.resetsAt ? new Date(signal.resetsAt).getTime() : NaN;
    return {
      key: signal.key,
      expiresAt: Number.isFinite(reset) && reset > now ? reset : now + DEFAULT_LIMIT_WINDOW_MS,
    };
  });
}
