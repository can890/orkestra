import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import z from 'zod';

const v1Schema = z.object({
  version: z.literal('1'),
  /** Ortak hafızası açık projelerin kimlikleri; varsayılan kapalıdır. */
  enabledProjects: z.array(z.string()),
});

export const projectMemorySettingsSchema = defineVersionedSchema().initial('1', v1Schema).build();
export type ProjectMemorySettings = typeof projectMemorySettingsSchema.Type;

/** Proje başına aç/kapat durumunu userData altındaki sürümlü JSON dosyasında tutar. */
export class ProjectMemorySettingsStore {
  private cache: Set<string> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async isEnabled(projectId: string): Promise<boolean> {
    return (await this.load()).has(projectId);
  }

  async setEnabled(projectId: string, enabled: boolean): Promise<void> {
    const run = this.writeChain.then(async () => {
      const next = new Set(await this.load());
      if (enabled) next.add(projectId);
      else next.delete(projectId);
      const payload: ProjectMemorySettings = { version: '1', enabledProjects: [...next].sort() };
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(projectMemorySettingsSchema.serialize(payload), 'utf8');
        } finally {
          await handle.close();
        }
        await rename(temp, this.filePath);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      this.cache = next;
    });
    this.writeChain = run.catch(() => undefined);
    await run;
  }

  private async load(): Promise<Set<string>> {
    if (this.cache) return this.cache;
    const raw = await readFile(this.filePath, 'utf8').catch(() => null);
    const parsed = projectMemorySettingsSchema.parseJson(raw);
    this.cache = new Set(parsed?.enabledProjects ?? []);
    return this.cache;
  }
}
