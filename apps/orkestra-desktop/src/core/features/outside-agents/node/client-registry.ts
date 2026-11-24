// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/mcp/McpSessionRegistry.ts
// (yalnızca belirteç özeti saklama ve iptal modeli; Effect ve iş parçacığı kapsamı kaldırıldı).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok, secret, type Result } from '@orkestra/shared';
import { z } from 'zod';
import {
  DEFAULT_OUTSIDE_AGENTS_PORT,
  MAX_OUTSIDE_AGENT_CLIENTS,
  outsideAgentAccessSchema,
  outsideAgentClientNameSchema,
  type OutsideAgentAccess,
  type OutsideAgentClient,
  type OutsideAgentsError,
} from '@core/features/outside-agents/api/contract';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

/**
 * Dış ajan istemcilerinin kaydı. Kalıcı durum (açık/kapalı, port, istemci listesi) kv tablosunda
 * sır içermeden tutulur; her istemcinin belirtecinin yalnızca SHA-256 özeti şifreli sır deposuna
 * yazılır. Belirtecin kendisi hiçbir yerde saklanmaz ve loglanmaz; kullanıcıya bir kez gösterilir.
 */

export const OUTSIDE_AGENT_TOKEN_PREFIX = 'orkmcp_';
const SECRET_KEY_PREFIX = 'outsideAgents.client.';
const CLIENT_ID_PATTERN = /^[0-9a-f]{16}$/;
const TOKEN_PATTERN = /^orkmcp_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
/** Son kullanım zamanı en fazla bu sıklıkta kalıcı duruma yazılır. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const storedClientSchema = z.object({
  id: z.string().regex(CLIENT_ID_PATTERN),
  name: z.string(),
  access: outsideAgentAccessSchema,
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});

export const storedOutsideAgentsStateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  clients: z.array(storedClientSchema),
});
export type StoredOutsideAgentsState = z.infer<typeof storedOutsideAgentsStateSchema>;

export type OutsideAgentsPersistence = {
  load(): Promise<unknown>;
  save(state: StoredOutsideAgentsState): Promise<void>;
};

/** Kimliği doğrulanmış istemci; her araç çağrısı bu bilgiyle yetki denetiminden geçer. */
export type OutsideAgentPrincipal = Readonly<{
  clientId: string;
  name: string;
  access: OutsideAgentAccess;
}>;

export type OutsideAgentClientRegistryDeps = {
  persistence: OutsideAgentsPersistence;
  secrets: SecretStore;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
};

export function defaultOutsideAgentsState(): StoredOutsideAgentsState {
  return { version: 1, enabled: false, port: DEFAULT_OUTSIDE_AGENTS_PORT, clients: [] };
}

export function hashOutsideAgentToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function secretKey(clientId: string): string {
  return `${SECRET_KEY_PREFIX}${clientId}`;
}

function failure(
  type: OutsideAgentsError['type'],
  message: string
): Result<never, OutsideAgentsError> {
  return err({ type, message });
}

/** Belirteç olmayan girişleri bile aynı maliyetle karşılaştırmak için sabit örnek. */
const DUMMY_HASH = hashOutsideAgentToken('orkestra-outside-agents-dummy');

export class OutsideAgentClientRegistry {
  private state: StoredOutsideAgentsState | undefined;
  /** İstemci kimliği → belirteç özeti; sır deposundan bir kez çözülür. */
  private readonly hashes = new Map<string, Buffer>();
  private readonly lastWrittenUse = new Map<string, number>();
  /** Diske henüz yazılmamış olabilecek en son kullanım zamanları. */
  private readonly lastSeen = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OutsideAgentClientRegistryDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private random(size: number): Buffer {
    return (this.deps.randomBytes ?? randomBytes)(size);
  }

  /** Durum değişikliklerini sıraya sokar (eşzamanlı yazmalar birbirini ezmesin). */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  async load(): Promise<StoredOutsideAgentsState> {
    if (this.state) return this.state;
    const raw = await this.deps.persistence.load().catch(() => null);
    const parsed = storedOutsideAgentsStateSchema.safeParse(raw);
    this.state = parsed.success ? parsed.data : defaultOutsideAgentsState();
    return this.state;
  }

  private async save(next: StoredOutsideAgentsState): Promise<void> {
    await this.deps.persistence.save(next);
    this.state = next;
  }

  async getSettings(): Promise<{ enabled: boolean; port: number }> {
    const state = await this.load();
    return { enabled: state.enabled, port: state.port };
  }

  updateSettings(patch: { enabled?: boolean; port?: number }): Promise<StoredOutsideAgentsState> {
    return this.exclusive(async () => {
      const state = await this.load();
      const next = { ...state, ...stripUndefined(patch) };
      await this.save(next);
      return next;
    });
  }

  async listClients(): Promise<OutsideAgentClient[]> {
    const state = await this.load();
    return state.clients.map((client) => {
      const seen = this.lastSeen.get(client.id);
      const lastUsedAt =
        seen !== undefined && (client.lastUsedAt === null || seen > client.lastUsedAt)
          ? seen
          : client.lastUsedAt;
      return { ...client, lastUsedAt };
    });
  }

  /** Yeni istemci üretir. Önce özet sır deposuna yazılır; kayıt ancak ondan sonra görünür. */
  createClient(
    name: string,
    access: OutsideAgentAccess
  ): Promise<Result<{ client: OutsideAgentClient; token: string }, OutsideAgentsError>> {
    return this.exclusive(async () => {
      const parsedName = outsideAgentClientNameSchema.safeParse(name);
      if (!parsedName.success) return failure('invalid_input', 'Client name is required.');
      const parsedAccess = outsideAgentAccessSchema.safeParse(access);
      if (!parsedAccess.success) return failure('invalid_input', 'Unknown permission level.');
      const state = await this.load();
      if (state.clients.length >= MAX_OUTSIDE_AGENT_CLIENTS) {
        return failure(
          'limit_reached',
          `At most ${MAX_OUTSIDE_AGENT_CLIENTS} clients can be connected. Revoke one first.`
        );
      }
      let id = this.random(8).toString('hex');
      while (state.clients.some((client) => client.id === id)) {
        id = this.random(8).toString('hex');
      }
      const token = `${OUTSIDE_AGENT_TOKEN_PREFIX}${id}_${this.random(32).toString('base64url')}`;
      const hash = hashOutsideAgentToken(token);
      await this.deps.secrets.setSecret(
        secretKey(id),
        secret(hash.toString('hex'), 'outside-agent-token-hash')
      );
      const client: OutsideAgentClient = {
        id,
        name: parsedName.data,
        access: parsedAccess.data,
        createdAt: this.now(),
        lastUsedAt: null,
      };
      try {
        await this.save({ ...state, clients: [...state.clients, client] });
      } catch (error) {
        await this.deps.secrets.deleteSecret(secretKey(id)).catch(() => {});
        throw error;
      }
      this.hashes.set(id, hash);
      return ok({ client: { ...client }, token });
    });
  }

  setClientAccess(
    id: string,
    access: OutsideAgentAccess
  ): Promise<Result<OutsideAgentClient, OutsideAgentsError>> {
    return this.exclusive(async () => {
      const state = await this.load();
      const existing = state.clients.find((client) => client.id === id);
      if (!existing) return failure('not_found', 'This client no longer exists.');
      const updated = { ...existing, access };
      await this.save({
        ...state,
        clients: state.clients.map((client) => (client.id === id ? updated : client)),
      });
      return ok({ ...updated });
    });
  }

  /** İstemciyi ve özetini siler; sonraki her istek reddedilir. */
  revokeClient(id: string): Promise<Result<void, OutsideAgentsError>> {
    return this.exclusive(async () => {
      const state = await this.load();
      if (!state.clients.some((client) => client.id === id)) {
        return failure('not_found', 'This client no longer exists.');
      }
      // Önce bellekten ve kalıcı listeden düşür: sır silme başarısız olsa bile erişim kapanır.
      this.hashes.delete(id);
      this.lastWrittenUse.delete(id);
      this.lastSeen.delete(id);
      await this.save({ ...state, clients: state.clients.filter((client) => client.id !== id) });
      await this.deps.secrets.deleteSecret(secretKey(id)).catch(() => {});
      return ok<void>();
    });
  }

  /**
   * Belirteci doğrular. Biçim, istemci kimliği ve özet denetlenir; özet karşılaştırması sabit
   * zamanlıdır. Bilinmeyen istemcilerde de aynı karşılaştırma yapılır.
   */
  async authenticate(token: string): Promise<OutsideAgentPrincipal | null> {
    const match = TOKEN_PATTERN.exec(token);
    const presented = hashOutsideAgentToken(token);
    if (!match) {
      timingSafeEqual(presented, DUMMY_HASH);
      return null;
    }
    const clientId = match[1]!;
    const state = await this.load();
    const client = state.clients.find((candidate) => candidate.id === clientId);
    const expected = client ? await this.storedHash(clientId) : null;
    const equal = timingSafeEqual(presented, expected ?? DUMMY_HASH);
    if (!client || !expected || !equal) return null;
    // İptal, özet okunurken gerçekleşmiş olabilir: güncel listeyle yeniden doğrula.
    const current = this.state?.clients.find((candidate) => candidate.id === clientId);
    if (!current) return null;
    return { clientId, name: current.name, access: current.access };
  }

  /** Güncel yetkiyi döndürür; istemci iptal edildiyse null (her araç çağrısında denetlenir). */
  currentAccess(clientId: string): OutsideAgentAccess | null {
    return this.state?.clients.find((client) => client.id === clientId)?.access ?? null;
  }

  /** Son kullanım zamanını günceller; diske dakikada en çok bir kez yazılır. */
  touch(clientId: string): void {
    const now = this.now();
    this.lastSeen.set(clientId, now);
    const last = this.lastWrittenUse.get(clientId);
    if (last !== undefined && now - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastWrittenUse.set(clientId, now);
    void this.exclusive(async () => {
      const state = await this.load();
      if (!state.clients.some((client) => client.id === clientId)) return;
      await this.save({
        ...state,
        clients: state.clients.map((client) =>
          client.id === clientId ? { ...client, lastUsedAt: now } : client
        ),
      });
    }).catch(() => {});
  }

  private async storedHash(clientId: string): Promise<Buffer | null> {
    const cached = this.hashes.get(clientId);
    if (cached) return cached;
    const stored = await this.deps.secrets.getSecret(secretKey(clientId)).catch(() => null);
    const hex = stored?.expose() ?? '';
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    const hash = Buffer.from(hex, 'hex');
    // Okuma sürerken istemci iptal edildiyse önbelleğe alma.
    if (this.state?.clients.some((client) => client.id === clientId)) {
      this.hashes.set(clientId, hash);
    }
    return hash;
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}
