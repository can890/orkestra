// Bu süreçte konuşma kayıt defteri en az bir kez başarıyla eşitlenmiş (anlık görüntü uygulanmış
// ve otomatik bağlama çalışmış) makineler. Masaüstü aynası ancak bundan sonra o makinenin
// bildiği konuşmaları yansıtır; "bu görevin hiç sohbeti yok" gibi kararlar buna dayanır.
// Süreç içi bellektir: yeniden başlatmada boşalır.

export type SyncedConversationHost = Readonly<{
  location: 'local' | 'remote';
  sshConnectionId: string | null;
}>;

const synced = new Set<string>();
const waiters = new Map<string, Set<() => void>>();

function keyOf(host: SyncedConversationHost): string {
  return host.location === 'local' ? 'local' : `remote:${host.sshConnectionId ?? ''}`;
}

export function markConversationHostSynced(host: SyncedConversationHost): void {
  const key = keyOf(host);
  synced.add(key);
  const pending = waiters.get(key);
  if (!pending) return;
  waiters.delete(key);
  for (const resolve of pending) resolve();
}

export function isConversationHostSynced(host: SyncedConversationHost): boolean {
  return synced.has(keyOf(host));
}

/** Makine eşitlenince `true`, `timeoutMs` içinde eşitlenmezse `false` döner. */
export function whenConversationHostSynced(
  host: SyncedConversationHost,
  timeoutMs: number
): Promise<boolean> {
  if (isConversationHostSynced(host)) return Promise.resolve(true);
  const key = keyOf(host);
  return new Promise((resolve) => {
    const onSynced = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.get(key)?.delete(onSynced);
      resolve(false);
    }, timeoutMs);
    let set = waiters.get(key);
    if (!set) {
      set = new Set();
      waiters.set(key, set);
    }
    set.add(onSynced);
  });
}

/** Yalnızca testler için. */
export function resetConversationHostSyncForTests(): void {
  synced.clear();
  waiters.clear();
}
