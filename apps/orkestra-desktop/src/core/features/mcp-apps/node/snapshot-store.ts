import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MCP_APP_MAX_HTML_BYTES,
  mcpAppCspSchema,
  mcpAppPermissionsSchema,
  transcriptMcpCallResultSchema,
} from '@orkestra/core/runtimes/acp/api/client';
import { z } from 'zod';

/**
 * Bir MCP uygulamasının konuşmayla birlikte saklanan anlık görüntüsü: belge HTML'i, kaynağın
 * bildirdiği CSP/izinler, aracın girdisi/sonucu ve sunucu kimliği. Böylece uygulama, tur bittikten
 * sonra ve sunucu artık erişilemese bile geçmişte (salt okunur) çizilebilir.
 *
 * Dosyalar `<kök>/<sha(konuşma)>/<sha(araç çağrısı)>.json` olarak, geçici dosya + yeniden adlandırma
 * ile yazılır (0600). Okunan dosya şemayla doğrulanır; bozuk ya da tanınmayan dosya yok sayılır.
 */

export const MCP_APP_SNAPSHOT_VERSION = 1;

export const mcpAppSnapshotSchema = z.object({
  version: z.literal(MCP_APP_SNAPSHOT_VERSION),
  conversationId: z.string(),
  toolCallId: z.string(),
  providerId: z.string(),
  /** Sağlayıcının bildirdiği sunucu adı. */
  server: z.string(),
  /** Yapılandırmadaki sunucu adı (bağlanırken bununla aranır). */
  serverName: z.string(),
  tool: z.string(),
  resourceUri: z.string(),
  html: z.string().max(MCP_APP_MAX_HTML_BYTES),
  csp: mcpAppCspSchema.optional(),
  permissions: mcpAppPermissionsSchema.optional(),
  prefersBorder: z.boolean().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  result: transcriptMcpCallResultSchema.optional(),
  toolDefinition: z.unknown().optional(),
  createdAt: z.number(),
});

export type McpAppSnapshot = z.infer<typeof mcpAppSnapshotSchema>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);

export class McpAppSnapshotStore {
  constructor(private readonly root: string) {}

  private pathOf(conversationId: string, toolCallId: string) {
    const dir = join(this.root, digest(conversationId));
    return { dir, file: join(dir, `${digest(toolCallId)}.json`) };
  }

  async read(conversationId: string, toolCallId: string): Promise<McpAppSnapshot | null> {
    const { file } = this.pathOf(conversationId, toolCallId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = mcpAppSnapshotSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      const snapshot = parsed.data;
      // Dosya adı çakışmasına ya da kopyalanmış dosyaya karşı kimlik yeniden denetlenir.
      if (snapshot.conversationId !== conversationId || snapshot.toolCallId !== toolCallId) {
        return null;
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  async write(snapshot: McpAppSnapshot): Promise<void> {
    const checked = mcpAppSnapshotSchema.parse(snapshot);
    const { dir, file } = this.pathOf(checked.conversationId, checked.toolCallId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(checked), { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** Bir konuşmanın tüm uygulama anlık görüntülerini siler. */
  async removeConversation(conversationId: string): Promise<void> {
    await rm(join(this.root, digest(conversationId)), { recursive: true, force: true });
  }
}
