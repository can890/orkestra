// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/provider-acp-registry/src/server/AcpRegistrySupport.ts
// Registry dizinini salt okunur, kısa zaman aşımlı bir GET ile alır; son başarılı yanıtı diske
// yazar ve ağ yokken bu önbellekle çalışır. Saat ve fetch enjekte edilir (testler ağsızdır).
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ACP_REGISTRY_ICON_ORIGIN,
  ACP_REGISTRY_URL,
  MAX_REGISTRY_BYTES,
  parseAcpRegistryIndex,
  type AcpRegistryAgent,
  type AcpRegistryIndex,
} from '../api/registry-schema';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Aramalar bu kadar yeni bir dizini yeniden kullanır (T3: 5 dakika). */
export const REGISTRY_FRESH_MS = 5 * 60 * 1_000;
/** Bundan eski önbellek arayüzde "eski" olarak gösterilir. */
export const REGISTRY_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
/** Ağ başarısız olduktan sonra yeniden denemeden önce beklenen süre (yenile hariç). */
const OFFLINE_RETRY_MS = 30 * 1_000;
const REGISTRY_TIMEOUT_MS = 10_000;
const ICON_TIMEOUT_MS = 10_000;
const MAX_ICON_BYTES = 512 * 1_024;

const cacheFileSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number(),
  text: z.string(),
});

export class AcpRegistryUnavailableError extends Error {}

export type RegistryLoadResult = {
  index: AcpRegistryIndex;
  fetchedAt: number | null;
  offline: boolean;
  stale: boolean;
  offlineReason: string | null;
};

export type AcpRegistryClientOptions = {
  cacheDir: string;
  fetch: FetchLike;
  now?: () => number;
  registryUrl?: string;
  timeoutMs?: number;
};

type MemoryState = {
  index: AcpRegistryIndex;
  fetchedAt: number | null;
  offline: boolean;
  offlineReason: string | null;
};

export class AcpRegistryClient {
  private readonly now: () => number;
  private readonly registryUrl: string;
  private readonly timeoutMs: number;
  private memory: MemoryState | undefined;
  private lastAttemptAt: number | undefined;
  private inFlight: Promise<RegistryLoadResult> | undefined;
  private readonly iconCache = new Map<string, string | null>();

  constructor(private readonly options: AcpRegistryClientOptions) {
    this.now = options.now ?? Date.now;
    this.registryUrl = options.registryUrl ?? ACP_REGISTRY_URL;
    this.timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  }

  private get cachePath(): string {
    return join(this.options.cacheDir, 'registry-cache.json');
  }

  /** Dizini döndürür: taze bellek kopyası, yoksa ağ, ağ başarısızsa disk önbelleği. */
  load(options: { refresh?: boolean } = {}): Promise<RegistryLoadResult> {
    if (this.inFlight) return this.inFlight;
    const pending = this.loadUncoalesced(options.refresh === true).finally(() => {
      if (this.inFlight === pending) this.inFlight = undefined;
    });
    this.inFlight = pending;
    return pending;
  }

  private async loadUncoalesced(refresh: boolean): Promise<RegistryLoadResult> {
    const now = this.now();
    const memory = this.memory;
    if (!refresh && memory) {
      const fresh =
        !memory.offline &&
        memory.fetchedAt !== null &&
        now >= memory.fetchedAt &&
        now - memory.fetchedAt < REGISTRY_FRESH_MS;
      const recentlyFailed =
        memory.offline &&
        this.lastAttemptAt !== undefined &&
        now - this.lastAttemptAt < OFFLINE_RETRY_MS;
      if (fresh || recentlyFailed) return this.result(memory);
    }

    this.lastAttemptAt = now;
    try {
      const text = await this.fetchIndexText();
      const index = parseAcpRegistryIndex(text);
      this.memory = { index, fetchedAt: now, offline: false, offlineReason: null };
      await this.writeCache(now, text);
      return this.result(this.memory);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = memory ?? (await this.readCache());
      if (!fallback) {
        throw new AcpRegistryUnavailableError(
          `Could not load the ACP Registry and no cached copy is available: ${reason}`
        );
      }
      this.memory = { ...fallback, offline: true, offlineReason: reason };
      return this.result(this.memory);
    }
  }

  /** Belirli bir ajanın güncel kaydı (kurulum planı için). */
  async findAgent(agentId: string): Promise<{ agent: AcpRegistryAgent; load: RegistryLoadResult }> {
    const load = await this.load();
    const agent = load.index.agents.find((candidate) => candidate.id === agentId.trim());
    if (!agent)
      throw new AcpRegistryAgentNotFoundError(`ACP Registry does not contain '${agentId}'.`);
    return { agent, load };
  }

  private result(memory: MemoryState): RegistryLoadResult {
    const now = this.now();
    const stale =
      memory.offline ||
      memory.fetchedAt === null ||
      now < memory.fetchedAt ||
      now - memory.fetchedAt > REGISTRY_STALE_AFTER_MS;
    return {
      index: memory.index,
      fetchedAt: memory.fetchedAt,
      offline: memory.offline,
      stale,
      offlineReason: memory.offlineReason,
    };
  }

  private async fetchIndexText(): Promise<string> {
    const bytes = await this.fetchBytes(this.registryUrl, this.timeoutMs, MAX_REGISTRY_BYTES);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.data);
    } catch {
      throw new Error('ACP Registry index is not valid UTF-8.');
    }
  }

  private async fetchBytes(
    url: string,
    timeoutMs: number,
    maxBytes: number
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.options.fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json, image/*' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`Response from ${url} exceeds ${maxBytes} bytes.`);
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > maxBytes)
        throw new Error(`Response from ${url} exceeds ${maxBytes} bytes.`);
      return { data, contentType: response.headers.get('content-type') ?? '' };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Timed out fetching ${url}.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCache(): Promise<MemoryState | undefined> {
    try {
      const parsed = cacheFileSchema.safeParse(JSON.parse(await readFile(this.cachePath, 'utf8')));
      if (!parsed.success) return undefined;
      return {
        index: parseAcpRegistryIndex(parsed.data.text),
        fetchedAt: parsed.data.fetchedAt,
        offline: true,
        offlineReason: null,
      };
    } catch {
      return undefined;
    }
  }

  private async writeCache(fetchedAt: number, text: string): Promise<void> {
    const temporary = `${this.cachePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await mkdir(this.options.cacheDir, { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, fetchedAt, text }));
      await rename(temporary, this.cachePath);
    } catch {
      // Önbellek yazılamaması aramayı bozmaz.
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Kayıt ikonunu yalnızca resmî CDN kökeninden indirip data URI olarak döndürür. */
  async iconDataUri(agent: AcpRegistryAgent): Promise<string | null> {
    const url = agent.icon;
    if (!url || !url.startsWith(`${ACP_REGISTRY_ICON_ORIGIN}/`)) return null;
    const cacheKey = `${agent.id}@${agent.version}`;
    if (this.iconCache.has(cacheKey)) return this.iconCache.get(cacheKey) ?? null;
    const diskPath = join(this.options.cacheDir, 'icons', `${encodeURIComponent(cacheKey)}.txt`);
    try {
      const cached = await readFile(diskPath, 'utf8');
      if (isAllowedIconDataUri(cached)) {
        this.iconCache.set(cacheKey, cached);
        return cached;
      }
    } catch {
      // Diskte yok; indir.
    }
    try {
      const { data, contentType } = await this.fetchBytes(url, ICON_TIMEOUT_MS, MAX_ICON_BYTES);
      const mime = iconMime(contentType, url);
      if (!mime) {
        this.iconCache.set(cacheKey, null);
        return null;
      }
      const dataUri = `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
      this.iconCache.set(cacheKey, dataUri);
      await mkdir(join(this.options.cacheDir, 'icons'), { recursive: true });
      await writeFile(diskPath, dataUri).catch(() => undefined);
      return dataUri;
    } catch {
      return null;
    }
  }
}

export class AcpRegistryAgentNotFoundError extends Error {}

const ALLOWED_ICON_MIMES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] as const;

function iconMime(contentType: string, url: string): string | null {
  const declared = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if ((ALLOWED_ICON_MIMES as readonly string[]).includes(declared)) return declared;
  // CDN bazen SVG'yi genel tiple sunar; uzantıya göre karar ver.
  if (
    (declared === '' || declared === 'application/octet-stream') &&
    /\.svg$/iu.test(new URL(url).pathname)
  ) {
    return 'image/svg+xml';
  }
  if (
    (declared === '' || declared === 'application/octet-stream' || declared === 'text/plain') &&
    !/\.[a-z]+$/iu.test(new URL(url).pathname)
  ) {
    // Uzantısız ikon yolları SVG olarak yayımlanır.
    return 'image/svg+xml';
  }
  return null;
}

export function isAllowedIconDataUri(value: string): boolean {
  return /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(value);
}
