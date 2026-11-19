import { err, ok, type Result } from '@orkestra/shared';
import type { MemoryEntry, MemoryEntrySummary, MemoryError } from '../api/memory-model';
import { buildMemoryPromptContext } from './memory-prompt';
import type { ProjectMemorySettingsStore } from './memory-settings';
import type { ProjectMemoryStore } from './memory-store';

export type ProjectMemoryState = {
  enabled: boolean;
  entries: MemoryEntrySummary[];
};

/**
 * Ayar (proje başına aç/kapat) ile depoyu birleştirir. Ajan araçları `enabled` kapalıyken hiç
 * eklenmez; arayüz ise kapalı projelerin kayıtlarını yine görüp silebilir.
 */
export class ProjectMemoryService {
  constructor(
    private readonly store: ProjectMemoryStore,
    private readonly settings: ProjectMemorySettingsStore
  ) {}

  isEnabled(projectId: string): Promise<boolean> {
    return this.settings.isEnabled(projectId);
  }

  setEnabled(projectId: string, enabled: boolean): Promise<void> {
    return this.settings.setEnabled(projectId, enabled);
  }

  async state(projectId: string): Promise<Result<ProjectMemoryState, MemoryError>> {
    const [enabled, entries] = await Promise.all([
      this.settings.isEnabled(projectId),
      this.store.list(projectId),
    ]);
    return entries.success ? ok({ enabled, entries: entries.data }) : err(entries.error);
  }

  list(projectId: string) {
    return this.store.list(projectId);
  }

  read(projectId: string, name: string): Promise<Result<MemoryEntry, MemoryError>> {
    return this.store.read(projectId, name);
  }

  write(projectId: string, input: { name: string; description: string; content: string }) {
    return this.store.write(projectId, input);
  }

  remove(projectId: string, name: string) {
    return this.store.remove(projectId, name);
  }

  removeProject(projectId: string): Promise<void> {
    return this.store.removeProject(projectId);
  }

  /** İlk prompt'a eklenecek dizin bloğu; ayar kapalıysa ya da kayıt yoksa null. */
  async promptContext(projectId: string): Promise<string | null> {
    if (!(await this.settings.isEnabled(projectId))) return null;
    const entries = await this.store.list(projectId);
    if (!entries.success) return null;
    return buildMemoryPromptContext(entries.data, this.store.maxIndexChars);
  }
}
