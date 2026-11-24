/**
 * WhatsApp tarzı çevrimdışı-öncelikli yerel önbellek (IndexedDB + anlık bellek katmanı).
 * Uygulama veya sohbet açıldığında 0 ms'de kayıtlı veriyi ekrana basar; arka planda canlı
 * WebSocket bağlantısı gelince sessizce eşitler.
 */
import type {
  AccountView,
  ConversationView,
  ProjectView,
  ProviderUsageView,
  SessionConfigView,
  TaskStatView,
  TranscriptEntry,
} from './mappers';

export type CachedWorkbench = {
  projects: ProjectView[];
  conversations: ConversationView[];
  agentNames: Record<string, string>;
  accounts: AccountView[];
  usage: Record<string, ProviderUsageView>;
  taskStats: Record<string, TaskStatView>;
  updatedAt: number;
};

export type CachedChat = {
  conversationId: string;
  entries: TranscriptEntry[];
  hasOlder: boolean;
  config?: SessionConfigView | null;
  updatedAt: number;
};

const DB_NAME = 'sovra_mobile_cache_v1';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const MAX_CACHED_CHATS_PER_HOST = 80;

const memWorkbench = new Map<string, CachedWorkbench>();
const memChats = new Map<string, CachedChat>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KV)) {
          db.createObjectStore(STORE_KV);
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

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_KV, 'readwrite');
      tx.objectStore(STORE_KV).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function workbenchKey(hostId: string): string {
  return `wb:${hostId}`;
}

function chatKey(hostId: string, conversationId: string): string {
  return `chat:${hostId}:${conversationId}`;
}

function chatIndexKey(hostId: string): string {
  return `chat-idx:${hostId}`;
}

export function getCachedWorkbenchSync(hostId: string): CachedWorkbench | null {
  return memWorkbench.get(hostId) ?? null;
}

export async function loadCachedWorkbench(hostId: string): Promise<CachedWorkbench | null> {
  const inMem = memWorkbench.get(hostId);
  if (inMem) return inMem;
  const fromDb = await idbGet<CachedWorkbench>(workbenchKey(hostId));
  if (fromDb) memWorkbench.set(hostId, fromDb);
  return fromDb;
}

export function saveCachedWorkbench(
  hostId: string,
  partial: Partial<Omit<CachedWorkbench, 'updatedAt'>>
): void {
  const prev = memWorkbench.get(hostId) ?? {
    projects: [],
    conversations: [],
    agentNames: {},
    accounts: [],
    usage: {},
    taskStats: {},
    updatedAt: 0,
  };
  const next: CachedWorkbench = {
    projects: partial.projects ?? prev.projects,
    conversations: partial.conversations ?? prev.conversations,
    agentNames: partial.agentNames ?? prev.agentNames,
    accounts: partial.accounts ?? prev.accounts,
    usage: partial.usage ?? prev.usage,
    taskStats: partial.taskStats ?? prev.taskStats,
    updatedAt: Date.now(),
  };
  memWorkbench.set(hostId, next);
  void idbPut(workbenchKey(hostId), next);
}

export function getCachedChatSync(hostId: string, conversationId: string): CachedChat | null {
  return memChats.get(chatKey(hostId, conversationId)) ?? null;
}

export async function loadCachedChat(
  hostId: string,
  conversationId: string
): Promise<CachedChat | null> {
  const key = chatKey(hostId, conversationId);
  const inMem = memChats.get(key);
  if (inMem) return inMem;
  const fromDb = await idbGet<CachedChat>(key);
  if (fromDb) memChats.set(key, fromDb);
  return fromDb;
}

export function saveCachedChat(
  hostId: string,
  conversationId: string,
  patch: { entries?: TranscriptEntry[]; hasOlder?: boolean; config?: SessionConfigView | null }
): void {
  const key = chatKey(hostId, conversationId);
  const prev = memChats.get(key);
  const entries = patch.entries ?? prev?.entries ?? [];
  // Son 180 öğeyi tut; bellek ve IndexedDB hep hızlı kalsın.
  const trimmedEntries = entries.length > 180 ? entries.slice(-180) : entries;
  const next: CachedChat = {
    conversationId,
    entries: trimmedEntries,
    hasOlder: patch.hasOlder ?? prev?.hasOlder ?? false,
    config: patch.config !== undefined ? patch.config : (prev?.config ?? null),
    updatedAt: Date.now(),
  };
  memChats.set(key, next);
  void (async () => {
    await idbPut(key, next);
    const idx = (await idbGet<string[]>(chatIndexKey(hostId))) ?? [];
    const filtered = idx.filter((id) => id !== conversationId);
    filtered.unshift(conversationId);
    if (filtered.length > MAX_CACHED_CHATS_PER_HOST) {
      const evicted = filtered.splice(MAX_CACHED_CHATS_PER_HOST);
      for (const oldId of evicted) {
        memChats.delete(chatKey(hostId, oldId));
        await idbDelete(chatKey(hostId, oldId));
      }
    }
    await idbPut(chatIndexKey(hostId), filtered);
  })();
}
