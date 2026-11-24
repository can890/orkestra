import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import z from 'zod';
import type { AtlasCardRecord } from '@core/features/atlas/api/atlas-model';

const cardRecordSchema = z.object({
  conversationId: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  title: z.string(),
  tags: z.array(z.string()),
  text: z.string(),
  writtenAt: z.number(),
  trigger: z.enum(['auto', 'manual']),
});

const v1Schema = z.object({
  version: z.literal('1'),
  /** Kart yazılmış sohbetler → yazılma anı (epoch ms). Tekrar yazmayı önleyen anahtar. */
  written: z.record(z.string(), z.number()),
  /** "Bu sohbete kart yazma" işaretli sohbetler. */
  skipped: z.array(z.string()),
  /** Arayüzde gösterilen son kartlar (en yenisi başta). */
  recent: z.array(cardRecordSchema),
  lastError: z.object({ message: z.string(), at: z.number() }).nullable(),
});

export const atlasStateSchema = defineVersionedSchema().initial('1', v1Schema).build();
export type AtlasState = typeof atlasStateSchema.Type;

const MAX_RECENT = 20;
const MAX_WRITTEN = 5000;

function emptyState(): AtlasState {
  return { version: '1', written: {}, skipped: [], recent: [], lastError: null };
}

/**
 * Atlas kart durumunu userData altındaki sürümlü JSON dosyasında tutar. Yazmalar sıraya
 * alınır ve geçici dosya + yeniden adlandırma ile atomik yapılır.
 */
export class AtlasStateStore {
  private cache: AtlasState | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(): Promise<AtlasState> {
    if (this.cache) return this.cache;
    const raw = await readFile(this.filePath, 'utf8').catch(() => null);
    this.cache = atlasStateSchema.parseJson(raw) ?? emptyState();
    return this.cache;
  }

  isWritten(state: AtlasState, conversationId: string): boolean {
    return state.written[conversationId] !== undefined;
  }

  /**
   * Sıralı okuma-değiştirme-yazma. `mutate` false dönerse dosyaya yazılmaz. Kart yazımı da bu
   * zincirde tutulur ki aynı sohbet için eşzamanlı iki istek iki kart yazamasın.
   */
  update<T>(mutate: (state: AtlasState) => Promise<{ value: T; changed: boolean }>): Promise<T> {
    const run = this.chain.then(async () => {
      const current = structuredClone(await this.get());
      const { value, changed } = await mutate(current);
      if (changed) await this.persist(current);
      return value;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  static recordCard(state: AtlasState, record: AtlasCardRecord): void {
    state.written[record.conversationId] = record.writtenAt;
    const keys = Object.keys(state.written);
    if (keys.length > MAX_WRITTEN) {
      const oldest = keys.sort((a, b) => state.written[a]! - state.written[b]!);
      for (const key of oldest.slice(0, keys.length - MAX_WRITTEN)) delete state.written[key];
    }
    state.recent = [record, ...state.recent].slice(0, MAX_RECENT);
    state.lastError = null;
  }

  private async persist(state: AtlasState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(atlasStateSchema.serialize(state), 'utf8');
      } finally {
        await handle.close();
      }
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.cache = state;
  }
}
