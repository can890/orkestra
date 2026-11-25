import { observable, runInAction } from 'mobx';

/** Kullanıcı ACP ajanlarının (yerel ve registry) kimlik öneki. */
const CUSTOM_ACP_PROVIDER_PREFIX = 'acp-';

/**
 * Kullanıcı ACP ajanlarının son bilinen adları. Açılışta meta veri bir kez yüklenene kadar
 * başlıklar kimlikten türemiş biçimde ("Acp-local-h-zl-ajan (1)") görünüp sonra ada dönüyordu;
 * son bilinen adlar eşzamanlı okunabilen localStorage'da tutulur ve tablo ilk çizimden önce
 * bunlarla doldurulur. Meta veri gelince tablo (ve kayıt) yine güncel adlarla tazelenir.
 */
const STORAGE_KEY = 'orkestra:agent-display-names:v1';

export function isCustomAcpProviderId(providerId: string): boolean {
  return providerId.toLowerCase().startsWith(CUSTOM_ACP_PROVIDER_PREFIX);
}

function readStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readPersistedNames(): Array<[string, string]> {
  try {
    const raw = readStorage()?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        isCustomAcpProviderId(entry[0]) && typeof entry[1] === 'string' && entry[1].trim() !== ''
    );
  } catch {
    return [];
  }
}

function persistCustomNames(): void {
  const storage = readStorage();
  if (!storage) return;
  const custom = Object.fromEntries([...names].filter(([id]) => isCustomAcpProviderId(id)));
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(custom));
  } catch {
    // Depolama doluysa ya da kapalıysa yalnızca titreme geri gelir; ad tablosu çalışmaya devam eder.
  }
}

/**
 * Sağlayıcı kimliğinden görünen ada eşzamanlı (MobX ile gözlenebilir) erişim. Sekme başlıkları ve
 * palet satırları gibi React sorgusu kullanamayan yerler, kullanıcı ACP ajanlarını
 * ("acp-local-hizli-ajan") kimliğiyle değil adıyla ("Hızlı Ajan") gösterebilsin diye tutulur.
 * `useAgentMetadata` her yüklemede tabloyu tazeler; ad gelince gözlemciler yeniden çizilir.
 */
const names = observable.map<string, string>(readPersistedNames());

export function rememberAgentDisplayNames(
  agents: ReadonlyArray<{ id: string; name: string }>
): void {
  let customChanged = false;
  runInAction(() => {
    for (const agent of agents) {
      const name = agent.name.trim();
      const id = agent.id.toLowerCase();
      if (!name || names.get(id) === name) continue;
      names.set(id, name);
      if (isCustomAcpProviderId(id)) customChanged = true;
    }
  });
  if (customChanged) persistCustomNames();
}

/** Bilinen görünen ad; meta veri henüz yüklenmediyse ve kayıtlı bir ad da yoksa `undefined`. */
export function agentDisplayName(providerId: string): string | undefined {
  return names.get(providerId.toLowerCase());
}

/** Yalnızca testler için. */
export function resetAgentDisplayNamesForTests(): void {
  runInAction(() => names.clear());
  try {
    readStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Testlerde depolama yoksa yapılacak bir şey yok.
  }
}
