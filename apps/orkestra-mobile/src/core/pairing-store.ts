import { DEFAULT_DISCOVERY_URL } from './discovery';
import { isValidAddress, type PairingPayload } from './pairing';

/**
 * Eşleştirme kaydının tek saklama noktası. Sır yalnızca `SecureStore` üzerinden yazılır
 * (Android'de Keystore destekli; bkz. `secure-store.ts`). Düz `localStorage`/Preferences yok.
 * Birden fazla bilgisayar (Mac, Huawei vb.) desteklenir; eski tekil `v1` kayıtları kayıpsız taşınır.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type PairingRecord = {
  hostId: string;
  hostName: string;
  addresses: string[];
  port: number;
  deviceId: string;
  /** Eşleştirme sırrı (base64url). Gösterilmez, loglanmaz. */
  secret: string;
  pairedAt: number;
  /** İsteğe bağlı salt-okunur dinamik tünel keşif URL'si (ör. gizli Gist). */
  discoveryUrl?: string;
};

export type PairingCollection = {
  activeHostId: string;
  hosts: PairingRecord[];
};

const STORE_KEY_V1 = 'orkestra.pairing.v1';
const STORE_KEY_V2 = 'orkestra.pairing.v2';
const MAX_HOSTS = 8;

export function recordFromPayload(payload: PairingPayload, now: number): PairingRecord {
  return {
    hostId: payload.h,
    hostName: payload.n,
    addresses: [...payload.a],
    port: payload.p,
    deviceId: payload.d,
    secret: payload.s,
    pairedAt: now,
    discoveryUrl: payload.u ?? DEFAULT_DISCOVERY_URL,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDiscoveryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('https://') || trimmed.length > 512) return undefined;
  return trimmed;
}

/** Bozuk/eksik kayıtta `null` döner (kullanıcı yeniden eşleşir); sırrı hata metnine koymaz. */
export function decodeRecord(text: string): PairingRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return decodeRecordObject(value);
}

function decodeRecordObject(value: unknown): PairingRecord | null {
  if (!isRecord(value)) return null;
  const { hostId, hostName, addresses, port, deviceId, secret, pairedAt, discoveryUrl } = value;
  if (typeof hostId !== 'string' || typeof hostName !== 'string') return null;
  if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every(isValidAddress)) {
    return null;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof deviceId !== 'string' || typeof secret !== 'string') return null;
  if (typeof pairedAt !== 'number') return null;
  const parsedDiscovery = parseDiscoveryUrl(discoveryUrl);
  return {
    hostId,
    hostName,
    addresses: [...addresses],
    port,
    deviceId,
    secret,
    pairedAt,
    ...(parsedDiscovery ? { discoveryUrl: parsedDiscovery } : {}),
  };
}

function decodeCollection(text: string): PairingCollection | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['version'] !== 2 || !Array.isArray(value['hosts'])) return null;
  const hosts = value['hosts']
    .map(decodeRecordObject)
    .filter((entry): entry is PairingRecord => entry !== null)
    .slice(0, MAX_HOSTS);
  if (hosts.length === 0) return null;
  const requestedActive = typeof value['activeHostId'] === 'string' ? value['activeHostId'] : '';
  const activeHostId = hosts.some((h) => h.hostId === requestedActive)
    ? requestedActive
    : hosts[0]!.hostId;
  return { activeHostId, hosts };
}

export type PairingRepository = {
  /** Aktif eşleşmiş bilgisayarı döner. */
  load(): Promise<PairingRecord | null>;
  /** Tüm kayıtlı bilgisayarları (Mac, Huawei vb.) ve aktif olanı döner. */
  loadAll(): Promise<PairingCollection | null>;
  /** Yeni bilgisayar ekler veya aynı `hostId` varsa günceller, aktif yapar. */
  save(record: PairingRecord): Promise<void>;
  /** Aktif bilgisayarı değiştirir. */
  setActiveHost(hostId: string): Promise<PairingCollection | null>;
  /** Tek bir bilgisayarı kaldırır; kalan varsa ilkini aktif yapar. */
  removeHost(hostId: string): Promise<PairingCollection | null>;
  /** Masaüstünün ya da keşif servisinin bildirdiği güncel adresleri (ve varsa portu) kaydeder. */
  updateAddresses(
    addresses: readonly string[],
    options?: { hostId?: string; port?: number; mergeExistingTunnels?: boolean }
  ): Promise<PairingRecord | null>;
  /** Bir bilgisayar için özel `wss://` tünel ya da LAN adresi ekler. */
  addAddress(hostId: string, address: string): Promise<PairingRecord | null>;
  /** Bir bilgisayar için dinamik keşif URL'sini günceller. */
  updateDiscoveryUrl(hostId: string, discoveryUrl: string | null): Promise<PairingRecord | null>;
  /** Tüm kayıtlı eşleşmeleri temizler. */
  clear(): Promise<void>;
};

export function createPairingRepository(store: SecureStore): PairingRepository {
  async function persist(collection: PairingCollection): Promise<void> {
    await store.set(STORE_KEY_V2, JSON.stringify({ version: 2, ...collection }));
    const active =
      collection.hosts.find((h) => h.hostId === collection.activeHostId) ?? collection.hosts[0];
    if (active) {
      await store.set(STORE_KEY_V1, JSON.stringify(active));
    }
  }

  async function loadAll(): Promise<PairingCollection | null> {
    const rawV2 = await store.get(STORE_KEY_V2);
    if (rawV2 !== null) {
      const parsed = decodeCollection(rawV2);
      if (parsed) return parsed;
      await store.remove(STORE_KEY_V2);
    }
    const rawV1 = await store.get(STORE_KEY_V1);
    if (rawV1 === null) return null;
    const legacy = decodeRecord(rawV1);
    if (!legacy) {
      await store.remove(STORE_KEY_V1);
      return null;
    }
    const collection: PairingCollection = { activeHostId: legacy.hostId, hosts: [legacy] };
    return collection;
  }

  async function load(): Promise<PairingRecord | null> {
    const col = await loadAll();
    if (!col) return null;
    return col.hosts.find((h) => h.hostId === col.activeHostId) ?? col.hosts[0] ?? null;
  }

  return {
    load,
    loadAll,
    async save(record) {
      const existing = await loadAll();
      const others = (existing?.hosts ?? []).filter((h) => h.hostId !== record.hostId);
      const next: PairingCollection = {
        activeHostId: record.hostId,
        hosts: [record, ...others].slice(0, MAX_HOSTS),
      };
      await persist(next);
    },
    async setActiveHost(hostId) {
      const col = await loadAll();
      if (!col || !col.hosts.some((h) => h.hostId === hostId)) return col;
      const next: PairingCollection = { ...col, activeHostId: hostId };
      await persist(next);
      return next;
    },
    async removeHost(hostId) {
      const col = await loadAll();
      if (!col) return null;
      const remaining = col.hosts.filter((h) => h.hostId !== hostId);
      if (remaining.length === 0) {
        await store.remove(STORE_KEY_V2);
        await store.remove(STORE_KEY_V1);
        return null;
      }
      const activeHostId =
        col.activeHostId === hostId ? remaining[0]!.hostId : col.activeHostId;
      const next: PairingCollection = { activeHostId, hosts: remaining };
      await persist(next);
      return next;
    },
    async updateAddresses(addresses, options) {
      const col = await loadAll();
      if (!col) return null;
      const targetId = options?.hostId ?? col.activeHostId;
      const current = col.hosts.find((h) => h.hostId === targetId);
      if (!current) return null;
      const incoming = addresses.filter(isValidAddress);
      const preservedTunnels = options?.mergeExistingTunnels
        ? current.addresses.filter((a) => a.startsWith('wss://') && !incoming.includes(a))
        : [];
      const nextAddresses = [...new Set([...incoming, ...preservedTunnels])].slice(0, 6);
      const nextPort =
        options?.port !== undefined &&
        Number.isInteger(options.port) &&
        options.port >= 1 &&
        options.port <= 65535
          ? options.port
          : current.port;
      if (
        nextAddresses.length === 0 ||
        (nextAddresses.join() === current.addresses.join() && nextPort === current.port)
      ) {
        return current;
      }
      const updated: PairingRecord = {
        ...current,
        addresses: nextAddresses,
        port: nextPort,
      };
      const nextCol: PairingCollection = {
        ...col,
        hosts: col.hosts.map((h) => (h.hostId === targetId ? updated : h)),
      };
      await persist(nextCol);
      return updated;
    },
    async addAddress(hostId, address) {
      const trimmed = address.trim();
      if (!isValidAddress(trimmed)) return null;
      const col = await loadAll();
      if (!col) return null;
      const current = col.hosts.find((h) => h.hostId === hostId);
      if (!current) return null;
      const nextAddresses = [
        trimmed,
        ...current.addresses.filter((entry) => entry !== trimmed),
      ].slice(0, 6);
      const updated: PairingRecord = { ...current, addresses: nextAddresses };
      const nextCol: PairingCollection = {
        ...col,
        hosts: col.hosts.map((h) => (h.hostId === hostId ? updated : h)),
      };
      await persist(nextCol);
      return updated;
    },
    async updateDiscoveryUrl(hostId, discoveryUrl) {
      const col = await loadAll();
      if (!col) return null;
      const current = col.hosts.find((h) => h.hostId === hostId);
      if (!current) return null;
      const parsed = discoveryUrl ? parseDiscoveryUrl(discoveryUrl) : undefined;
      const updated: PairingRecord = { ...current };
      if (parsed) updated.discoveryUrl = parsed;
      else delete updated.discoveryUrl;
      const nextCol: PairingCollection = {
        ...col,
        hosts: col.hosts.map((h) => (h.hostId === hostId ? updated : h)),
      };
      await persist(nextCol);
      return updated;
    },
    async clear() {
      await store.remove(STORE_KEY_V2);
      await store.remove(STORE_KEY_V1);
    },
  };
}

/** Testler ve tarayıcı geliştirme modu için: bellekte tutar, hiçbir yere yazmaz. */
export function createMemorySecureStore(): SecureStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  };
}
