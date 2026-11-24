import type { TranscriptTurn } from '@orkestra/core/runtimes/acp/api/client';

/**
 * Masaüstü ACP sohbetleri için anlık (0 ms) bellek + kalıcı IndexedDB transkript önbelleği.
 *
 * Sohbete tıklandığında CLI/SSH `attach` + `loadHistory` yanıtını beklemeden kayıtlı
 * mesajları anında ekrana çizer; canlı oturum arkada sessizce bağlanıp güncel veriyi eşitler.
 */

const DB_NAME = 'sovra-desktop-transcripts-v1';
const STORE_NAME = 'transcripts';
const MAX_CACHED_CONVERSATIONS = 250;
const MAX_TURNS_PER_CONVERSATION = 120;

type CachedTranscriptRecord = {
  conversationId: string;
  turns: TranscriptTurn[];
  savedAt: number;
};

const memoryCache = new Map<string, CachedTranscriptRecord>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
let prewarmStarted = false;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'conversationId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Uygulama açılışında tüm kayıtlı sohbet önbelleğini arka planda RAM'e ısıtır (~5 ms). */
export function prewarmDesktopTranscriptCache(): void {
  if (prewarmStarted || typeof indexedDB === 'undefined') return;
  prewarmStarted = true;
  void openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const rows = req.result as CachedTranscriptRecord[] | undefined;
        if (!Array.isArray(rows)) return;
        rows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
        for (const row of rows.slice(0, MAX_CACHED_CONVERSATIONS)) {
          if (
            row &&
            typeof row.conversationId === 'string' &&
            Array.isArray(row.turns) &&
            row.turns.length > 0 &&
            !memoryCache.has(row.conversationId)
          ) {
            memoryCache.set(row.conversationId, row);
          }
        }
      };
    } catch {
      // IndexedDB okunamazsa sessizce canlı yüklemeye devam edilir.
    }
  });
}

// Tarayıcı/Electron ortamında modül yüklendiği anda önbelleği ısıt.
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
  prewarmDesktopTranscriptCache();
}

export function getCachedTranscriptSync(conversationId: string): TranscriptTurn[] | null {
  const entry = memoryCache.get(conversationId);
  if (!entry || entry.turns.length === 0) return null;
  return entry.turns;
}

export async function loadCachedTranscript(
  conversationId: string
): Promise<TranscriptTurn[] | null> {
  const syncHit = getCachedTranscriptSync(conversationId);
  if (syncHit) return syncHit;
  const db = await openDb();
  if (!db) return null;
  return await new Promise<TranscriptTurn[] | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(conversationId);
      req.onsuccess = () => {
        const row = req.result as CachedTranscriptRecord | undefined;
        if (row && Array.isArray(row.turns) && row.turns.length > 0) {
          memoryCache.set(conversationId, row);
          resolve(row.turns);
          return;
        }
        resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function sanitizeTurnsForStorage(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  const trimmed =
    turns.length > MAX_TURNS_PER_CONVERSATION
      ? turns.slice(turns.length - MAX_TURNS_PER_CONVERSATION)
      : [...turns];
  // MobX / Solid proxy sarmalayıcılarını temizle; IndexedDB structuredClone hatasını önler.
  try {
    return JSON.parse(JSON.stringify(trimmed)) as TranscriptTurn[];
  } catch {
    return [];
  }
}

export function saveCachedTranscript(
  conversationId: string,
  turns: readonly TranscriptTurn[]
): void {
  if (!conversationId || turns.length === 0) return;
  const clean = sanitizeTurnsForStorage(turns);
  if (clean.length === 0) return;
  const record: CachedTranscriptRecord = {
    conversationId,
    turns: clean,
    savedAt: Date.now(),
  };
  memoryCache.delete(conversationId);
  memoryCache.set(conversationId, record);
  while (memoryCache.size > MAX_CACHED_CONVERSATIONS) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) memoryCache.delete(oldestKey);
    else break;
  }

  void openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(record);
      // Nadiren eski kayıtları temizle
      if (memoryCache.size >= MAX_CACHED_CONVERSATIONS) {
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => {
          const keys = keysReq.result as string[] | undefined;
          if (!Array.isArray(keys) || keys.length <= MAX_CACHED_CONVERSATIONS + 20) return;
          for (const key of keys) {
            if (!memoryCache.has(key)) {
              try {
                store.delete(key);
              } catch {
                // yoksay
              }
            }
          }
        };
      }
    } catch {
      // Depolama doluysa sessizce yoksay.
    }
  });
}

export function clearDesktopTranscriptMemoryCacheForTest(): void {
  memoryCache.clear();
}
