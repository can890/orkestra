import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';

const hashedItemSchema = z.object({ id: z.string(), hash: z.string() });

const marketplaceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  url: z.string(),
  addedAt: z.number(),
});

const installRecordSchema = z.object({
  marketplaceId: z.string(),
  plugin: z.string(),
  hostKey: z.string(),
  installedAt: z.number(),
  skills: z.array(hashedItemSchema),
  mcpServers: z.array(hashedItemSchema),
  prompts: z.array(hashedItemSchema),
});

const v1Schema = z.object({
  version: z.literal('1'),
  marketplaces: z.array(marketplaceRecordSchema),
  installs: z.array(installRecordSchema),
});

/** userData altındaki `plugin-packs/state.json` içeriği: marketplace'ler ve köken kayıtları. */
export const pluginPacksStateFile = defineVersionedSchema().initial('1', v1Schema).build();

export type PluginPacksStateFile = typeof pluginPacksStateFile.Type;
export type MarketplaceRecord = z.infer<typeof marketplaceRecordSchema>;
export type InstallRecord = z.infer<typeof installRecordSchema>;
export type HashedItem = z.infer<typeof hashedItemSchema>;

export function emptyState(): PluginPacksStateFile {
  return { version: '1', marketplaces: [], installs: [] };
}

export class ProvenanceStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.file = join(rootDir, 'state.json');
  }

  async read(): Promise<PluginPacksStateFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error('Eklenti kayıt dosyası okunamadı (bozuk JSON).');
    }
    const parsed = pluginPacksStateFile.safeParse(json);
    if (parsed.status === 'ok') return parsed.data;
    if (parsed.status === 'future-version') {
      throw new Error('Eklenti kayıtları daha yeni bir uygulama sürümüyle yazılmış.');
    }
    throw new Error('Eklenti kayıt dosyası geçersiz.');
  }

  /** Okuma-değiştirme-yazma işlemlerini sıraya koyar; yazma atomiktir (geçici dosya + rename). */
  update<T>(
    mutate: (state: PluginPacksStateFile) => { state: PluginPacksStateFile; result: T }
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const current = await this.read();
      const { state, result } = mutate(structuredClone(current));
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, pluginPacksStateFile.serialize(state), { mode: 0o600 });
      await rename(tmp, this.file);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
