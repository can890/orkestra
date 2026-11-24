// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/workflows/WorkflowStore.ts
//
// T3 çalıştırma günlüğünü SQLite'ta tutar. Orkestra'da yeni tablo/migration gerekmesin diye her
// çalıştırma `userData/workflows/runs/<id>.json` dosyasında, tetikleyici durumu `state.json`
// dosyasında tutulur. Her yazım geçici dosya + `rename` ile atomiktir; bir adımın sonucu,
// adım başarıyla bittiği anda diske yazılır.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { codeWorkflowRunSchema, type CodeWorkflowRun } from '../contract';

const RUN_FILE = /^[A-Za-z0-9-]{1,80}\.json$/;

export const engineStateSchema = z.object({
  version: z.literal(1),
  /** `<iş akışı>|<tetikleyici kimliği>` → sonraki planlı an. */
  schedules: z.record(z.string(), z.number()),
  /** Yoklama tetikleyicisi → daha önce görülen öğe kimlikleri. */
  polls: z.record(z.string(), z.array(z.string())),
});
export type EngineState = z.infer<typeof engineStateSchema>;

export function emptyEngineState(): EngineState {
  return { version: 1, schedules: {}, polls: {} };
}

export class WorkflowRunStore {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    readonly directory: string,
    private readonly warn: (message: string, context?: Record<string, unknown>) => void = () => {}
  ) {}

  private get runsDirectory(): string {
    return join(this.directory, 'runs');
  }

  async loadRuns(): Promise<CodeWorkflowRun[]> {
    const names = await readdir(this.runsDirectory).catch(() => [] as string[]);
    const runs: CodeWorkflowRun[] = [];
    for (const name of names) {
      if (!RUN_FILE.test(name)) continue;
      const raw = await readFile(join(this.runsDirectory, name), 'utf8').catch(() => null);
      if (raw === null) continue;
      try {
        const parsed = codeWorkflowRunSchema.safeParse(JSON.parse(raw));
        if (parsed.success) runs.push(parsed.data);
        else this.warn('Workflows: run file is not valid, ignored', { file: name });
      } catch {
        this.warn('Workflows: run file could not be parsed, ignored', { file: name });
      }
    }
    return runs.sort((a, b) => a.createdAt - b.createdAt);
  }

  saveRun(run: CodeWorkflowRun): Promise<void> {
    return this.write(join(this.runsDirectory, `${run.id}.json`), JSON.stringify(run));
  }

  deleteRun(runId: string): Promise<void> {
    const file = join(this.runsDirectory, `${runId}.json`);
    return this.chain(file, () => rm(file, { force: true }));
  }

  async loadState(): Promise<EngineState> {
    const raw = await readFile(join(this.directory, 'state.json'), 'utf8').catch(() => null);
    if (raw === null) return emptyEngineState();
    try {
      const parsed = engineStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Bozuk durum dosyası boş durumla değiştirilir; çalıştırmalar etkilenmez.
    }
    this.warn('Workflows: trigger state is not valid, starting fresh');
    return emptyEngineState();
  }

  saveState(state: EngineState): Promise<void> {
    return this.write(join(this.directory, 'state.json'), JSON.stringify(state));
  }

  /** Bekleyen tüm yazımları bekler. */
  async flush(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private write(file: string, content: string): Promise<void> {
    return this.chain(file, async () => {
      await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, file);
    });
  }

  private chain(file: string, work: () => Promise<unknown>): Promise<void> {
    const previous = this.chains.get(file) ?? Promise.resolve();
    const next = previous
      .then(work)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.warn('Workflows: could not write', { file, error: String(error) });
      });
    this.chains.set(file, next);
    void next.finally(() => {
      if (this.chains.get(file) === next) this.chains.delete(file);
    });
    return next;
  }
}
