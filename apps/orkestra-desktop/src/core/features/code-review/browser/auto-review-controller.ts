import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { toast } from '@orkestra/ui/react/primitives';
import { comparer, reaction } from 'mobx';
import {
  AUTO_REVIEW_DEBOUNCE_MS,
  AutoReviewScheduler,
  changeFingerprint,
  decideAutoReview,
  pruneRecentReviews,
  REVIEW_IN_FLIGHT_TIMEOUT_MS,
} from '@core/features/code-review/api/auto-review';
import { isPrimaryConversation } from '@core/features/code-review/api/review-participants';
import { isReviewConversationTitle } from '@core/features/code-review/api/review-prompt';
import type { ConversationManagerStore } from '@core/features/conversations/api/browser/conversation-manager';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTaskGitCheckoutStore } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import type { AgentStatus } from '@core/primitives/agents/api';
import { log } from '@core/primitives/logging/browser/logger';
import { codeReviewSettingsReady, getProjectReviewSettings } from './review-settings';
import { openConversationTab, startCodeReview } from './start-code-review';

type ConversationStatusRow = Readonly<{
  id: string;
  status: AgentStatus;
  primary: boolean;
  review: boolean;
}>;

type GitState = Readonly<{
  fingerprint: string;
  headOid: string | null;
  hasUncommittedChanges: boolean;
}>;

/**
 * Görev başına "ajan turu bitince otomatik incele" denetleyicisi. Ana konuşmaların tur
 * başlangıç/bitişlerini izler, bitişleri geciktirerek birleştirir ve süre dolunca saf karar
 * fonksiyonuna göre bir inceleme başlatır. Görevde aynı anda en fazla bir inceleme çalışır.
 */
export class AutoReviewController {
  private readonly previous = new Map<string, AgentStatus>();
  private readonly scheduler: AutoReviewScheduler;
  private readonly disposeReaction: () => void;
  /** İlk tur başlangıcındaki git durumu; karar verilince sıfırlanır. */
  private gitBefore: GitState | null = null;
  private lastReviewedFingerprint: string | null = null;
  private recentAutoReviews: number[] = [];
  private inFlight: { conversationId: string; startedAt: number } | null = null;
  private starting = false;
  private disposed = false;

  constructor(
    private readonly projectId: string,
    private readonly taskId: string,
    manager: ConversationManagerStore | undefined = conversationRegistry.get(taskId)
  ) {
    this.scheduler = new AutoReviewScheduler({
      debounceMs: AUTO_REVIEW_DEBOUNCE_MS,
      onFire: () => void this.fire(),
    });
    if (!manager) {
      this.disposeReaction = () => {};
      return;
    }
    this.disposeReaction = reaction(
      () =>
        Array.from(
          manager.conversations.values(),
          (conversation): ConversationStatusRow => ({
            id: conversation.data.id,
            status: conversation.status,
            primary: isPrimaryConversation(conversation.data),
            review: isReviewConversationTitle(conversation.data.title),
          })
        ),
      (rows) => this.onStatuses(rows),
      { fireImmediately: true, equals: comparer.structural }
    );
  }

  private readGitState(): GitState | null {
    const git = getTaskGitCheckoutStore(this.projectId, this.taskId);
    if (!git?.hasData) return null;
    const changes = git.fileChanges;
    return {
      fingerprint: changeFingerprint({ headOid: git.headOid, changes }),
      headOid: git.headOid,
      hasUncommittedChanges: changes.length > 0,
    };
  }

  private onStatuses(rows: readonly ConversationStatusRow[]): void {
    const present = new Set(rows.map((row) => row.id));
    for (const id of [...this.previous.keys()]) {
      if (!present.has(id)) this.previous.delete(id);
    }
    if (this.inFlight && !present.has(this.inFlight.conversationId)) this.inFlight = null;

    for (const row of rows) {
      const before = this.previous.get(row.id);
      this.previous.set(row.id, row.status);
      if (before === undefined || before === row.status) continue;

      if (row.review) {
        // Başlattığımız inceleme turu bitince görev yeni incelemeye açılır.
        if (this.inFlight?.conversationId === row.id && before === 'working') this.inFlight = null;
        continue;
      }
      if (!row.primary) continue;
      if (row.status === 'working') {
        this.gitBefore ??= this.readGitState();
        this.scheduler.turnStarted();
      } else if (before === 'working' && row.status === 'completed') {
        this.scheduler.turnFinished();
      }
    }
  }

  private reviewRunning(now: number): boolean {
    if (this.starting) return true;
    if (this.inFlight && now - this.inFlight.startedAt > REVIEW_IN_FLIGHT_TIMEOUT_MS) {
      this.inFlight = null;
    }
    if (this.inFlight) return true;
    const manager = conversationRegistry.get(this.taskId);
    // Kullanıcının elle başlattığı ve hâlâ çalışan incelemeler de sayılır.
    return Array.from(manager?.conversations.values() ?? []).some(
      (conversation) =>
        isReviewConversationTitle(conversation.data.title) && conversation.status === 'working'
    );
  }

  private agentWorking(): boolean {
    const manager = conversationRegistry.get(this.taskId);
    return Array.from(manager?.conversations.values() ?? []).some(
      (conversation) =>
        isPrimaryConversation(conversation.data) && conversation.status === 'working'
    );
  }

  private async fire(): Promise<void> {
    if (this.disposed) return;
    try {
      await codeReviewSettingsReady();
    } catch {
      return;
    }
    if (this.disposed) return;
    const settings = getProjectReviewSettings(this.projectId);
    const now = Date.now();
    const gitNow = this.readGitState();
    const decision = decideAutoReview({
      enabled: settings.autoReview && settings.providerId !== null,
      reviewRunning: this.reviewRunning(now),
      agentWorking: this.agentWorking(),
      fingerprintBefore: this.gitBefore?.fingerprint ?? null,
      fingerprintNow: gitNow?.fingerprint ?? null,
      headBefore: this.gitBefore?.headOid ?? null,
      headNow: gitNow?.headOid ?? null,
      hasUncommittedChanges: gitNow?.hasUncommittedChanges ?? false,
      lastReviewedFingerprint: this.lastReviewedFingerprint,
      recentAutoReviews: this.recentAutoReviews,
      now,
      preferredScope: settings.scope,
    });
    // Ajan hâlâ çalışıyorsa başlangıç durumu korunur; bir sonraki bitişte yeniden değerlendirilir.
    if (decision.kind === 'skip' && decision.reason === 'agent-working') return;
    this.gitBefore = null;
    if (decision.kind === 'skip') {
      log.debug('[code-review] Otomatik inceleme atlandı', { reason: decision.reason });
      return;
    }
    if (!settings.providerId || !gitNow) return;

    this.starting = true;
    try {
      const { conversationId } = await startCodeReview({
        projectId: this.projectId,
        taskId: this.taskId,
        providerId: settings.providerId as AgentProviderId,
        model: settings.model,
        scope: decision.scope,
        focus: settings.focus,
        instructions: settings.instructions,
        autoApprove: settings.autoApprove,
        open: false,
      });
      this.inFlight = { conversationId, startedAt: Date.now() };
      this.lastReviewedFingerprint = gitNow.fingerprint;
      this.recentAutoReviews = [...pruneRecentReviews(this.recentAutoReviews, now), now];
      toast('Otomatik inceleme başlatıldı', {
        action: {
          label: 'Aç',
          onClick: () => openConversationTab(this.projectId, this.taskId, conversationId),
        },
      });
    } catch (error) {
      log.warn('[code-review] Otomatik inceleme başlatılamadı', error);
      toast.error('Otomatik inceleme başlatılamadı', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.starting = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.scheduler.dispose();
    this.disposeReaction();
  }
}
