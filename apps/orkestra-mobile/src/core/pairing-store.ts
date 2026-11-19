import { isValidAddress, type PairingPayload } from './pairing';

/**
 * Eşleştirme kaydının tek saklama noktası. Sır yalnızca `SecureStore` üzerinden yazılır
 * (Android'de Keystore destekli; bkz. `secure-store.ts`). Düz `localStorage`/Preferences yok.
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
};

const STORE_KEY = 'orkestra.pairing.v1';

export function recordFromPayload(payload: PairingPayload, now: number): PairingRecord {
  return {
    hostId: payload.h,
    hostName: payload.n,
    addresses: [...payload.a],
    port: payload.p,
    deviceId: payload.d,
    secret: payload.s,
    pairedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bozuk/eksik kayıtta `null` döner (kullanıcı yeniden eşleşir); sırrı hata metnine koymaz. */
export function decodeRecord(text: string): PairingRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { hostId, hostName, addresses, port, deviceId, secret, pairedAt } = value;
  if (typeof hostId !== 'string' || typeof hostName !== 'string') return null;
  if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every(isValidAddress)) {
    return null;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof deviceId !== 'string' || typeof secret !== 'string') return null;
  if (typeof pairedAt !== 'number') return null;
  return { hostId, hostName, addresses: [...addresses], port, deviceId, secret, pairedAt };
}

export type PairingRepository = {
  load(): Promise<PairingRecord | null>;
  save(record: PairingRecord): Promise<void>;
  /** Masaüstünün bildirdiği güncel adreslerle kayıtlı adresleri değiştirir (DHCP değişimi). */
  updateAddresses(addresses: readonly string[]): Promise<PairingRecord | null>;
  clear(): Promise<void>;
};

export function createPairingRepository(store: SecureStore): PairingRepository {
  async function load(): Promise<PairingRecord | null> {
    const text = await store.get(STORE_KEY);
    if (text === null) return null;
    const record = decodeRecord(text);
    if (!record) await store.remove(STORE_KEY);
    return record;
  }
  return {
    load,
    async save(record) {
      await store.set(STORE_KEY, JSON.stringify(record));
    },
    async updateAddresses(addresses) {
      const record = await load();
      if (!record) return null;
      const next = [...new Set(addresses.filter(isValidAddress))].slice(0, 6);
      if (next.length === 0 || next.join() === record.addresses.join()) return record;
      const updated = { ...record, addresses: next };
      await store.set(STORE_KEY, JSON.stringify(updated));
      return updated;
    },
    async clear() {
      await store.remove(STORE_KEY);
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
