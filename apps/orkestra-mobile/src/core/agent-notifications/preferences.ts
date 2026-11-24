// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/mobile/src/features/agent-awareness/liveActivityPreferences.ts
// Kategoriler (bitti / hata / onay / soru) ve "süren etkinlik" anahtarı T3'ün bildirim
// tercihleriyle aynı; T3'teki bulut kaydı yerine tercihler telefonda kalır ve yerel servise verilir.

/**
 * Telefonun ajan bildirim tercihleri. Sır içermez: düz `localStorage`'da tutulur. Yerel servis
 * (Android) aynı alanları `NotifyPrefs.java` ile okur; varsayılanlar iki tarafta aynıdır.
 */
export type AgentNotificationPrefs = {
  /** Arka plan bildirimleri (ön plan servisi + yerel bağlantı). Varsayılan kapalı. */
  enabled: boolean;
  finished: boolean;
  failed: boolean;
  approval: boolean;
  question: boolean;
  /** "Çalışan ajanlar" süren etkinlik kartı. */
  ongoing: boolean;
};

export type AgentNotificationCategory = 'finished' | 'failed' | 'approval' | 'question';

export const AGENT_NOTIFICATION_CATEGORIES: readonly {
  id: AgentNotificationCategory;
  label: string;
  description: string;
}[] = [
  { id: 'approval', label: 'Onay bekliyor', description: 'Ajan bir eylem için izninizi bekliyor.' },
  { id: 'question', label: 'Soru soruyor', description: 'Ajan sizden yanıt bekliyor.' },
  { id: 'finished', label: 'İşini bitirdi', description: 'Ajan turu tamamlandı.' },
  { id: 'failed', label: 'Hata verdi', description: 'Ajan turu hatayla bitti.' },
];

export const DEFAULT_AGENT_NOTIFICATION_PREFS: AgentNotificationPrefs = {
  enabled: false,
  finished: true,
  failed: true,
  approval: true,
  question: true,
  ongoing: true,
};

export const AGENT_NOTIFICATION_PREFS_KEY = 'orkestra:mobile:agent-notifications';

/** Bozuk/eksik alanlar varsayılana düşer; bilinmeyen alanlar atılır. */
export function normalizeAgentNotificationPrefs(value: unknown): AgentNotificationPrefs {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const pick = (key: keyof AgentNotificationPrefs): boolean =>
    typeof source[key] === 'boolean'
      ? (source[key] as boolean)
      : DEFAULT_AGENT_NOTIFICATION_PREFS[key];
  return {
    enabled: pick('enabled'),
    finished: pick('finished'),
    failed: pick('failed'),
    approval: pick('approval'),
    question: pick('question'),
    ongoing: pick('ongoing'),
  };
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** React (`useSyncExternalStore`) ile kullanılan küçük tercih deposu. */
export function createAgentNotificationPrefsStore(
  storage: KeyValueStorage | null = defaultStorage()
) {
  const listeners = new Set<() => void>();
  let current = (() => {
    try {
      const raw = storage?.getItem(AGENT_NOTIFICATION_PREFS_KEY);
      return normalizeAgentNotificationPrefs(raw ? JSON.parse(raw) : null);
    } catch {
      return DEFAULT_AGENT_NOTIFICATION_PREFS;
    }
  })();
  return {
    get: (): AgentNotificationPrefs => current,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch: Partial<AgentNotificationPrefs>): AgentNotificationPrefs {
      current = normalizeAgentNotificationPrefs({ ...current, ...patch });
      try {
        storage?.setItem(AGENT_NOTIFICATION_PREFS_KEY, JSON.stringify(current));
      } catch {
        // Depolama dolu/kapalı: bellekteki değer yine geçerli.
      }
      for (const listener of listeners) listener();
      return current;
    },
  };
}

export type AgentNotificationPrefsStore = ReturnType<typeof createAgentNotificationPrefsStore>;

export const agentNotificationPrefs = createAgentNotificationPrefsStore();
