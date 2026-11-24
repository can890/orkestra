// Kullanıcı ACP ajanlarının dosyası (`<userData>/acp-registry/agents.json`). Yazmalar sıraya
// konur ve atomiktir (geçici dosya + rename); her yazmadan sonra eklenti kaydı yeniden okunur.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parseCustomAcpAgentsFile,
  serializeCustomAcpAgentsFile,
  type CustomAcpAgent,
} from '@orkestra/plugins/agents';

export function customAcpAgentsFilePath(userDataDir: string): string {
  return join(userDataDir, 'acp-registry', 'agents.json');
}

export class CustomAcpAgentStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly onChange: () => void = () => undefined
  ) {}

  async list(): Promise<CustomAcpAgent[]> {
    await this.queue.catch(() => undefined);
    return this.read();
  }

  async get(id: string): Promise<CustomAcpAgent | undefined> {
    return (await this.list()).find((agent) => agent.id === id);
  }

  /** Okuma-değiştirme-yazma; değiştirici sırayla çalışır. */
  update<T>(
    mutate: (
      agents: CustomAcpAgent[]
    ) => Promise<{ agents: CustomAcpAgent[]; result: T }> | { agents: CustomAcpAgent[]; result: T }
  ): Promise<T> {
    const run = this.queue
      .catch(() => undefined)
      .then(async () => {
        const current = await this.read();
        const { agents, result } = await mutate(current);
        await this.write(agents);
        this.onChange();
        return result;
      });
    this.queue = run;
    return run;
  }

  private async read(): Promise<CustomAcpAgent[]> {
    try {
      return parseCustomAcpAgentsFile(await readFile(this.filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  private async write(agents: CustomAcpAgent[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serializeCustomAcpAgentsFile(agents), { mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
