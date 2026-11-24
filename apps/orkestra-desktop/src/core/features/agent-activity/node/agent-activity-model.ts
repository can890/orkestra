// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/milestones/OrchestrationMilestones.ts
// T3 orkestrasyon olaylarından "tur bitti / girdi bekliyor" kilometre taşları türetir; burada aynı
// fikir Orkestra'nın ajan durum sinyallerine (start/stop/error/notification) uygulanır ve sonuç,
// telefona gidecek küçük bir "sohbet başına güncel durum" modeline indirgenir.
import {
  AGENT_ACTIVITY_ALERT_STATES,
  AGENT_ACTIVITY_LABEL_CHARS,
  AGENT_ACTIVITY_MAX_ENTRIES,
  AGENT_ACTIVITY_PREVIEW_CHARS,
  AGENT_ACTIVITY_SETTLED_RETENTION_MS,
  type AgentActivityEntry,
  type AgentActivityState,
} from '../api/contract';

/** `AgentEvent` ile yapısal olarak uyumlu, saf modelin ihtiyaç duyduğu alt küme. */
export type AgentActivitySignal = {
  type: 'start' | 'stop' | 'error' | 'notification';
  conversationId: string;
  timestamp: number;
  payload: {
    notificationType?: string;
    title?: string;
    message?: string;
    lastAssistantMessage?: string;
  };
};

/** Ajan durum servisinin `status:changed` kancasındaki durum değerleri. */
export type AgentActivityStatus = 'idle' | 'working' | 'awaiting-input' | 'error' | 'completed';

/** Sohbetin görüntü bağlamı (DB'den çözülür). */
export type AgentActivityContext = {
  projectId: string;
  taskId: string;
  title: string;
  projectName: string;
  providerName: string;
};

export type AgentActivityChange =
  | { kind: 'upsert'; entry: AgentActivityEntry; alert: boolean }
  | { kind: 'remove'; conversationId: string; revision: number };

export type AgentActivityModelState = {
  entries: Map<string, AgentActivityEntry>;
  revision: number;
};

/** Aynı duruma kısa aralıkla gelen tekrar sinyaller (kanca + köprü) yeni tur sayılmaz. */
const DUPLICATE_SETTLE_WINDOW_MS = 2_000;

const ACTIVE_STATES: ReadonlySet<AgentActivityState> = new Set([
  'working',
  'needs-approval',
  'asked-question',
]);

export function createAgentActivityModel(): AgentActivityModelState {
  return { entries: new Map(), revision: 0 };
}

export function isActiveState(state: AgentActivityState): boolean {
  return ACTIVE_STATES.has(state);
}

export function isAlertState(state: AgentActivityState): boolean {
  return AGENT_ACTIVITY_ALERT_STATES.has(state);
}

/** Tek satıra indirger ve sınırlar; kontrol karakterleri atılır. */
export function clampText(value: string | undefined | null, maxChars: number): string {
  if (!value) return '';
  const flat = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Bildirim türü → bekleme durumu (T3 `inputKind` eşlemesinin karşılığı). */
export function waitingStateFor(notificationType: string | undefined): AgentActivityState | null {
  switch (notificationType) {
    case 'permission_prompt':
      return 'needs-approval';
    case 'idle_prompt':
    case 'elicitation_dialog':
      return 'asked-question';
    default:
      return null;
  }
}

/** Sinyal → hedef durum; ilgisiz sinyaller (`auth_success` vb.) için `null`. */
export function targetStateForSignal(signal: AgentActivitySignal): AgentActivityState | null {
  switch (signal.type) {
    case 'start':
      return 'working';
    case 'stop':
      return 'finished';
    case 'error':
      return 'failed';
    case 'notification':
      return waitingStateFor(signal.payload.notificationType);
  }
}

function previewFor(signal: AgentActivitySignal, state: AgentActivityState): string {
  if (state === 'working') return '';
  const text =
    state === 'finished' || state === 'failed'
      ? (signal.payload.lastAssistantMessage ?? signal.payload.message)
      : (signal.payload.message ?? signal.payload.title);
  return clampText(text, AGENT_ACTIVITY_PREVIEW_CHARS);
}

function nextRevision(model: AgentActivityModelState): number {
  model.revision += 1;
  return model.revision;
}

function contextFields(context: AgentActivityContext) {
  return {
    projectId: context.projectId,
    taskId: context.taskId,
    title: clampText(context.title, AGENT_ACTIVITY_LABEL_CHARS),
    projectName: clampText(context.projectName, AGENT_ACTIVITY_LABEL_CHARS),
    providerName: clampText(context.providerName, AGENT_ACTIVITY_LABEL_CHARS),
  };
}

/**
 * Bir ajan sinyalini uygular. Değişiklik yoksa boş liste döner. `alert`, telefonun bu geçiş için
 * bildirim göstermesi gerekip gerekmediğidir: yalnızca uyarı durumuna YENİ girişte `true`
 * (aynı bekleme durumunun tekrarı ya da kanca+köprü kaynaklı çift `stop` bildirim üretmez).
 */
export function applyAgentSignal(
  model: AgentActivityModelState,
  signal: AgentActivitySignal,
  context: AgentActivityContext
): AgentActivityChange[] {
  const state = targetStateForSignal(signal);
  if (!state) return [];
  const previous = model.entries.get(signal.conversationId);
  const at = signal.timestamp;

  if (previous) {
    if (previous.state === state) {
      if (state === 'working' || state === 'needs-approval' || state === 'asked-question') {
        return [];
      }
      // Biten/başarısız tekrarları: ancak belirgin biçimde daha yeni bir tur ise yeni sonuçtur.
      if (at - previous.stateChangedAt <= DUPLICATE_SETTLE_WINDOW_MS) return [];
    }
    // Sıra dışı (eski) sinyaller durumu geri sarmaz.
    if (at < previous.stateChangedAt) return [];
  }

  const entry: AgentActivityEntry = {
    conversationId: signal.conversationId,
    ...contextFields(context),
    state,
    preview: previewFor(signal, state),
    stateChangedAt: at,
    startedAt:
      state === 'working'
        ? at
        : previous && isActiveState(previous.state)
          ? previous.startedAt
          : null,
    revision: nextRevision(model),
  };
  model.entries.set(entry.conversationId, entry);
  return [{ kind: 'upsert', entry, alert: isAlertState(state) }];
}

/**
 * `status:changed` kancası. Yalnızca iki şeyi yapar: (1) `idle` sıfırlaması süren işi (iptal,
 * oturum kapandı) sessizce kaldırır, biten/başarısız sonuç kartta kalır; (2) açılışta önbellekten
 * gelen `working`/`awaiting-input` durumlarıyla, hiç kaydı olmayan sohbetleri sessizce tohumlar.
 * Bitti/hata ve bekleme türü ayrıntısı `agent:event` sinyalinden gelir (`applyAgentSignal`).
 */
export function applyStatusChange(
  model: AgentActivityModelState,
  change: { conversationId: string; status: AgentActivityStatus; at: number },
  context: AgentActivityContext | null
): AgentActivityChange[] {
  const previous = model.entries.get(change.conversationId);
  if (change.status === 'idle') {
    if (!previous || !isActiveState(previous.state)) return [];
    model.entries.delete(change.conversationId);
    return [
      { kind: 'remove', conversationId: change.conversationId, revision: nextRevision(model) },
    ];
  }
  if (previous || !context) return [];
  const state: AgentActivityState | null =
    change.status === 'working'
      ? 'working'
      : change.status === 'awaiting-input'
        ? 'needs-approval'
        : null;
  if (!state) return [];
  const entry: AgentActivityEntry = {
    conversationId: change.conversationId,
    ...contextFields(context),
    state,
    preview: '',
    stateChangedAt: change.at,
    startedAt: change.at,
    revision: nextRevision(model),
  };
  model.entries.set(entry.conversationId, entry);
  // Tohumlama sessizdir: açılışta eski bir bekleyen durumu "yeni" gibi bildirmeyiz.
  return [{ kind: 'upsert', entry, alert: false }];
}

/**
 * Saklama: biten/başarısız sonuçlar `AGENT_ACTIVITY_SETTLED_RETENTION_MS` sonra düşer; toplam kayıt
 * `AGENT_ACTIVITY_MAX_ENTRIES` ile sınırlıdır (önce en eski sonuçlar, gerekirse en eski süren işler).
 */
export function pruneAgentActivity(
  model: AgentActivityModelState,
  now: number,
  maxEntries = AGENT_ACTIVITY_MAX_ENTRIES
): AgentActivityChange[] {
  const changes: AgentActivityChange[] = [];
  const drop = (conversationId: string) => {
    model.entries.delete(conversationId);
    changes.push({ kind: 'remove', conversationId, revision: nextRevision(model) });
  };
  for (const entry of [...model.entries.values()]) {
    if (
      !isActiveState(entry.state) &&
      now - entry.stateChangedAt > AGENT_ACTIVITY_SETTLED_RETENTION_MS
    ) {
      drop(entry.conversationId);
    }
  }
  if (model.entries.size > maxEntries) {
    const ordered = orderEntries([...model.entries.values()]);
    for (const entry of ordered.slice(maxEntries).reverse()) drop(entry.conversationId);
  }
  return changes;
}

/** Görüntü sırası: önce süren işler, sonra sonuçlar; her grupta en yeni önce. */
export function orderEntries(entries: readonly AgentActivityEntry[]): AgentActivityEntry[] {
  return [...entries].sort((a, b) => {
    const activeDelta = Number(isActiveState(b.state)) - Number(isActiveState(a.state));
    if (activeDelta !== 0) return activeDelta;
    return b.stateChangedAt - a.stateChangedAt || b.revision - a.revision;
  });
}
