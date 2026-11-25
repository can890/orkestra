import { isValidAddress } from './pairing';

/**
 * Sovra ücretsiz Cloudflare Quick Tunnel (trycloudflare.com) dinamik uç nokta keşfi.
 * Keşif belgesinde YALNIZCA geçici `wss://...trycloudflare.com` ve yerel ağ adresleri vardır;
 * hiçbir sır, şifre veya token bulunmaz. Bağlantıda AES-256-GCM cihaz sırrı el sıkışması zorunludur.
 */
export const DEFAULT_DISCOVERY_GIST_ID = '2a507ceddfc22470421213e78ca42608';
export const DEFAULT_DISCOVERY_URL = `https://gist.githubusercontent.com/can890/${DEFAULT_DISCOVERY_GIST_ID}/raw/sovra-endpoints.json`;
const DISCOVERY_TIMEOUT_MS = 6_000;

export type DiscoveredEndpoint = {
  addresses: string[];
  port?: number;
  name?: string;
  updatedAt?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GitHub Gist API yanıtından veya doğrudan ham JSON'dan `sovra-endpoints.json` belgesini çıkarır. */
export function parseDiscoveryDocument(raw: unknown, hostId: string): DiscoveredEndpoint | null {
  let doc: unknown = raw;
  if (isRecord(raw) && isRecord(raw['files'])) {
    const file = raw['files']['sovra-endpoints.json'];
    if (isRecord(file) && typeof file['content'] === 'string') {
      try {
        doc = JSON.parse(file['content']);
      } catch {
        return null;
      }
    }
  }
  if (!isRecord(doc) || !isRecord(doc['hosts'])) return null;
  const host = doc['hosts'][hostId];
  if (!isRecord(host)) return null;

  const collected: string[] = [];
  if (typeof host['tunnelUrl'] === 'string' && isValidAddress(host['tunnelUrl'])) {
    collected.push(host['tunnelUrl']);
  }
  if (Array.isArray(host['addresses'])) {
    for (const entry of host['addresses']) {
      if (isValidAddress(entry)) collected.push(entry);
    }
  }
  const addresses = [...new Set(collected)].slice(0, 6);
  if (addresses.length === 0) return null;

  const port =
    typeof host['port'] === 'number' &&
    Number.isInteger(host['port']) &&
    host['port'] >= 1 &&
    host['port'] <= 65535
      ? host['port']
      : undefined;
  const name =
    typeof host['name'] === 'string' && host['name'].trim() ? host['name'].trim() : undefined;
  const updatedAt = typeof host['updatedAt'] === 'number' ? host['updatedAt'] : undefined;

  return {
    addresses,
    ...(port !== undefined ? { port } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export async function fetchDiscoveryEndpoint(
  discoveryUrl: string,
  hostId: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<DiscoveredEndpoint | null> {
  if (!discoveryUrl || !hostId || typeof fetchImpl !== 'function') return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(discoveryUrl);
    if (parsedUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS) : null;
  try {
    // CDN önbelleğini atlamak için 15 saniyelik dilimle sorgu parametresi ekle (GitHub raw gist)
    if (parsedUrl.hostname === 'gist.githubusercontent.com' && !parsedUrl.search) {
      parsedUrl.searchParams.set('t', String(Math.floor(Date.now() / 15_000)));
    }
    const response = await fetchImpl(parsedUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json, application/json' },
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    return parseDiscoveryDocument(json, hostId);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
