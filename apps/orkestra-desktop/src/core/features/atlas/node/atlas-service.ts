import type { TranscriptTurn } from '@orkestra/core/runtimes/acp/api/client';
import { err, ok, type Result } from '@orkestra/shared';
import {
  clampResultLimit,
  deriveCardTags,
  normalizeAtlasQuery,
  type AtlasCardRecord,
  type AtlasError,
  type AtlasSettings,
  type AtlasStatus,
} from '@core/features/atlas/api/atlas-model';
import {
  buildCardPrompt,
  buildHeuristicCard,
  extractConversationFacts,
  isTrivialConversation,
  limitCard,
  type CardContext,
} from './atlas-card';
import type { AtlasCli, AtlasDetection } from './atlas-cli';
import { AtlasStateStore } from './atlas-state-store';

export type AtlasConversationInfo = {
  id: string;
  projectId: string | null;
  taskId: string | null;
  title: string | null;
  workspacePath: string | null;
};

export type AtlasServiceDeps = {
  settings(): Promise<AtlasSettings>;
  cli: AtlasCli;
  store: AtlasStateStore;
  conversation(conversationId: string): Promise<AtlasConversationInfo | null>;
  conversationsForTask(taskId: string): Promise<AtlasConversationInfo[]>;
  projectName(projectId: string): Promise<string | null>;
  task(taskId: string): Promise<{ name: string; branch: string | null } | null>;
  transcript(conversationId: string): Promise<readonly TranscriptTurn[]>;
  /** Başlık/commit iletisiyle aynı metin üretimi; kapalıysa ya da hata verirse null. */
  generateText(input: { systemPrompt: string; prompt: string }): Promise<string | null>;
  /** Yazılan kartın küçük bildirimi (uygulama içi bildirim, sohbete "aç" hedefiyle). */
  notify(record: AtlasCardRecord): void;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  now?: () => number;
};

const AGENT_NAME = 'orkestra';

/**
 * Atlas entegrasyonunun ana süreç tarafı: CLI algılama, insan araması, sohbet başına kart
 * yazma. Kart yazımı durum deposunun sıralı zincirinde yapılır; aynı sohbet için iki kart
 * yazılmaz. Hatalar akışı engellemez; son hata ayarın durum satırında gösterilir.
 */
export class AtlasService {
  private detection: AtlasDetection | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: AtlasServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async status(refresh = false): Promise<AtlasStatus> {
    const [settings, state] = await Promise.all([this.deps.settings(), this.deps.store.get()]);
    if (refresh || !this.detection) this.detection = await this.deps.cli.detect();
    return {
      settings,
      cli: this.detection,
      lastError: state.lastError,
      recentCards: state.recent,
      skippedConversations: state.skipped.length,
    };
  }

  async isSearchEnabled(): Promise<boolean> {
    return (await this.deps.settings()).searchEnabled;
  }

  async search(rawQuery: unknown, rawLimit?: unknown): Promise<Result<string, AtlasError>> {
    if (!(await this.isSearchEnabled())) return err(disabled('Atlas search is turned off.'));
    const query = normalizeAtlasQuery(rawQuery);
    if (!query) return err(invalid('Enter a single-line search term (max 200 characters).'));
    return this.recordFailure(await this.deps.cli.search(query, clampResultLimit(rawLimit)));
  }

  async projectHistory(projectId: string): Promise<Result<string, AtlasError>> {
    if (!(await this.isSearchEnabled())) return err(disabled('Atlas search is turned off.'));
    const name = await this.deps.projectName(projectId);
    if (!name) return err({ code: 'not-found', message: 'Unknown project.' });
    return this.recordFailure(await this.deps.cli.history(name));
  }

  async conversationState(conversationId: string) {
    const state = await this.deps.store.get();
    return {
      written: state.written[conversationId] !== undefined,
      skipped: state.skipped.includes(conversationId),
    };
  }

  setSkipped(conversationId: string, skipped: boolean): Promise<void> {
    return this.deps.store.update(async (state) => {
      const has = state.skipped.includes(conversationId);
      if (has === skipped) return { value: undefined, changed: false };
      state.skipped = skipped
        ? [...state.skipped, conversationId].slice(-2000)
        : state.skipped.filter((id) => id !== conversationId);
      return { value: undefined, changed: true };
    });
  }

  /** Görev arşivlendi: ayar açıksa görevin her sohbeti için (gerekirse) kart yazar. */
  async onTaskArchived(taskId: string): Promise<void> {
    const settings = await this.deps.settings();
    if (!settings.autoCardEnabled) return;
    const conversations = await this.deps.conversationsForTask(taskId).catch(() => []);
    for (const conversation of conversations) {
      const result = await this.writeCard(conversation.id, 'auto').catch((error: unknown) =>
        err<AtlasError>({ code: 'failed', message: String(error) })
      );
      if (!result.success && !isQuietSkip(result.error)) {
        this.deps.logger.warn('Atlas card was not written', {
          conversationId: conversation.id,
          code: result.error.code,
        });
      }
    }
  }

  /**
   * Bir sohbet için kart yazar. `manual`: ayar ve "yazma" işareti yok sayılır, yalnızca daha
   * önce yazılmamış olması gerekir. `auto`: ayar açık, işaretsiz ve önemsiz olmayan sohbet.
   */
  writeCard(
    conversationId: string,
    trigger: 'auto' | 'manual'
  ): Promise<Result<AtlasCardRecord, AtlasError>> {
    return this.deps.store.update<Result<AtlasCardRecord, AtlasError>>(async (state) => {
      const settings = await this.deps.settings();
      if (trigger === 'auto' && !settings.autoCardEnabled) {
        return { value: err(disabled('Automatic Atlas cards are turned off.')), changed: false };
      }
      if (state.written[conversationId] !== undefined) {
        return {
          value: err({
            code: 'already-written',
            message: 'An Atlas card was already written for this conversation.',
          }),
          changed: false,
        };
      }
      if (trigger === 'auto' && state.skipped.includes(conversationId)) {
        return {
          value: err({ code: 'skipped', message: 'This conversation is marked "no card".' }),
          changed: false,
        };
      }
      const conversation = await this.deps.conversation(conversationId);
      if (!conversation) {
        return {
          value: err({ code: 'not-found', message: 'Conversation not found.' }),
          changed: false,
        };
      }
      const turns = await this.deps.transcript(conversationId).catch(() => []);
      const facts = extractConversationFacts(turns);
      if (isTrivialConversation(facts)) {
        return {
          value: err({ code: 'trivial', message: 'The conversation has no real work to record.' }),
          changed: false,
        };
      }
      const [projectName, task] = await Promise.all([
        conversation.projectId ? this.deps.projectName(conversation.projectId) : null,
        conversation.taskId ? this.deps.task(conversation.taskId) : null,
      ]);
      const context: CardContext = {
        projectName,
        taskName: task?.name ?? null,
        conversationTitle: conversation.title,
        branch: task?.branch ?? null,
        workspacePath: conversation.workspacePath,
        language: settings.cardLanguage,
      };
      const generated = await this.deps
        .generateText(buildCardPrompt(facts, context))
        .catch(() => null);
      const text = generated?.trim() ? limitCard(generated) : buildHeuristicCard(facts, context);
      const tags = deriveCardTags(
        projectName,
        [task?.name, conversation.title].filter(Boolean).join(' ')
      );
      const written = await this.deps.cli.writeCard({
        text,
        tags,
        agent: AGENT_NAME,
        session: conversationId,
        ...(projectName ? { project: projectName } : {}),
      });
      if (!written.success) {
        state.lastError = { message: written.error.message, at: this.now() };
        return { value: err(written.error), changed: true };
      }
      const record: AtlasCardRecord = {
        conversationId,
        projectId: conversation.projectId,
        taskId: conversation.taskId,
        title: conversation.title ?? task?.name ?? conversationId,
        tags,
        text,
        writtenAt: this.now(),
        trigger,
      };
      AtlasStateStore.recordCard(state, record);
      try {
        this.deps.notify(record);
      } catch {
        // Bildirim hatası kartı geri almaz.
      }
      return { value: ok(record), changed: true };
    });
  }

  private async recordFailure(
    result: Result<string, AtlasError>
  ): Promise<Result<string, AtlasError>> {
    if (!result.success && result.error.code !== 'invalid-input') {
      await this.deps.store
        .update(async (state) => {
          state.lastError = { message: result.error.message, at: this.now() };
          return { value: undefined, changed: true };
        })
        .catch(() => undefined);
    }
    return result;
  }
}

function disabled(message: string): AtlasError {
  return { code: 'disabled', message };
}

function invalid(message: string): AtlasError {
  return { code: 'invalid-input', message };
}

function isQuietSkip(error: AtlasError): boolean {
  return (
    error.code === 'already-written' ||
    error.code === 'skipped' ||
    error.code === 'trivial' ||
    error.code === 'disabled'
  );
}
