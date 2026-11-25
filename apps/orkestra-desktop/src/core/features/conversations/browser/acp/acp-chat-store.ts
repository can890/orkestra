import type {
  ChatContext,
  ChatImageAttachment,
  ChatState,
  ChatView,
  TranscriptTurn,
} from '@orkestra/chat-ui';
import { formatHostRef } from '@orkestra/core/primitives/host/api';
import type {
  AgentState,
  PromptAttachment,
  PromptInput,
  PromptPlacement,
  QueuedPrompt,
  SessionMcpServer,
  TranscriptTurn as RuntimeTranscriptTurn,
} from '@orkestra/core/runtimes/acp/api/client';
import type { AttachmentMimeType, AttachmentRef } from '@orkestra/core/services/attachments/api';
import { createScope, type Scope } from '@orkestra/shared/concurrency';
import { TimeoutError, runWithTimeout, systemClock } from '@orkestra/shared/scheduling';
import {
  PromptEditorModel,
  type CommandItem,
  type ComposerCollaborationModeOption,
  type ComposerEffortOption,
  type ComposerModelOption,
  type ComposerPermissionModeOption,
  type ComposerQueuedPrompt,
} from '@orkestra/ui/react/components';
import { toast } from '@orkestra/ui/react/primitives';
import type { BlobSource } from '@orkestra/wire/rpc';
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import { getAgentsClient, hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import {
  registerConversationCommands,
  unregisterConversationCommands,
} from '@core/features/conversations/api/browser/chat/advertised-command-provider';
import { getChatUiRuntime } from '@core/features/conversations/api/browser/chat/chat-ui-runtime';
import { getSharedChatContext } from '@core/features/conversations/api/browser/chat/shared-chat-context';
import {
  getConversationsClient,
  type ConversationsClient,
} from '@core/features/conversations/api/browser/client';
import { initHandoffPersistence } from '@core/features/conversations/api/browser/handoff-visibility';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { HandoffTurn } from '@core/features/conversations/api/handoff-summary';
import { updateProviderPreference } from '@core/features/conversations/browser/provider-preferences';
import {
  ACP_DRAFT_MAX_LENGTH,
  acpDraftMemento,
  type AcpDraftState,
} from '@core/features/conversations/contributions/mementos';
import { conversationSubject } from '@core/features/conversations/contributions/subject';
import type { ProjectHostAccess } from '@core/features/projects/api/browser/stores/project-context';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { getUsageLimitsClient } from '@core/features/usage-limits/api/browser/client';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { log } from '@core/primitives/logging/browser/logger';
import {
  getMementoClient,
  type MementoHandle,
  type SubjectSpace,
} from '@core/primitives/mementos/browser';
import { resolveForkAncestorPrefixTurns } from '../handoff/fork-ancestor-hydration';
import {
  consumePendingDraftText,
  getCachedPrefixTurns,
  getHandoffStore,
  setCachedPrefixTurns,
} from '../handoff/handoff-store';
import { limitErrorTurnId } from '../handoff/handoff-suggestions';
import { hydrateChainPrefixTurns } from '../handoff/switch-provider-in-place';
import {
  AcpLiveSession,
  AcpPromptDeliveryUnknownError,
  AcpStartError,
  asValueSource,
} from './acp-live-session';
import { bindSessionTerminalOutputs } from './acp-terminal-output-binding';
import {
  getCachedTranscriptSync,
  loadCachedTranscript,
  saveCachedTranscript,
} from './acp-transcript-cache';
import { localizeAgentLabel } from './agent-labels-tr';
import {
  catalogModelName,
  clearedModelNoticeMessage,
  clearedModelNotices,
  type ClearedSelectionReport,
} from './cleared-model-notice';
import { HistoryRefreshTrigger } from './history-refresh-trigger';
import { turnPromptText } from './turn-liveness';

export interface AgentAffordances {
  isWorking: boolean;
  isBusy: boolean;
  isResuming: boolean;
  hasPendingPermission: boolean;
  canSubmit: boolean;
  canCancel: boolean;
}

type StoredPromptAttachment = Extract<PromptAttachment, { type: 'attachment' }>;

const draftAttachmentDataUrlCache = new Map<string, string>();

export type AcpPromptAttachment = {
  ref: StoredPromptAttachment;
  previewUrl?: string;
};

type AcpAttachmentUploadMetadata = {
  mimeType: AttachmentMimeType;
  name?: string;
};

export type AcpAttachmentUploadInput = AcpAttachmentUploadMetadata &
  (
    | { data: Uint8Array; source?: never; size?: never }
    | { data?: never; source: BlobSource; size?: number }
  );

type PermissionQueueItem = {
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type AcpLoadError =
  | { kind: 'auth_required'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'history_unavailable'; message: string }
  | { kind: 'generic'; message: string };

export class AcpChatStore {
  readonly chatContext: ChatContext;
  readonly chatState: ChatState;
  readonly composerModel = new PromptEditorModel();

  session: AcpLiveSession | null = null;
  historyLoading = true;
  sessionConnecting = false;
  historyKnown: boolean;
  loadError: AcpLoadError | null = null;
  /**
   * When this client last saw the running turn change. Only a fallback for turn liveness when
   * the runtime does not report `SessionState.activity` (older workspace servers).
   */
  observedActivityAt: number | null = null;
  messageCount = 0;
  prefixTurnCount = 0;
  /** Son (tamamlanmış) tur kullanım/oran limiti hatasıyla bittiyse o turun kimliği. */
  lastLimitErrorTurnId: string | null = null;
  private readonly _draftText = observable.box('');
  get draftText(): string {
    return this._draftText.get();
  }
  draftAttachments: AcpPromptAttachment[] = [];
  unconfirmedPromptIds: string[] = [];

  private _view: ChatView | null = null;
  private _bootstrapped = false;
  private _unsubs: Array<() => void> = [];
  private readonly _scope: Scope;
  private readonly _draftSpace: SubjectSpace<'conversation'>;
  private readonly _draftHandle: MementoHandle<AcpDraftState>;
  private readonly _disposeComposerSubscription: () => void;
  private readonly _disposeHostReaction: () => void;
  private readonly _disposeUsageReaction: () => void;
  private _hasInitializedUsageBaseline: boolean;
  private _lastRecordedContextUsed = 0;
  private _lastRecordedCostUsd = 0;
  private _attachmentsClientPromise: Promise<ConversationsClient['attachments']> | null = null;
  private _submissionSequence = 0;
  private _historyRefreshRequested = false;
  private _historyRefreshTrigger: HistoryRefreshTrigger | null = null;
  private _historyRefreshTask: Promise<void> | null = null;
  private _historyEpoch = 0;
  private _disposed = false;
  private _attachmentRecovery: Scope | null = null;
  private _attachedHostGeneration: number | undefined;
  private _bootstrapFailed = false;

  constructor(
    readonly conversationId: string,
    readonly projectId: string,
    readonly taskId: string,
    readonly hostAccess?: ProjectHostAccess
  ) {
    const conversation = conversationRegistry.get(taskId)?.conversations.get(conversationId)?.data;
    this.historyKnown = conversation !== undefined && !conversation.sessionId;
    this._hasInitializedUsageBaseline = conversation !== undefined && !conversation.sessionId;
    this.chatContext = getSharedChatContext();
    this._scope = createScope({ label: `acp-chat:${conversationId}` });
    this.chatState = getChatUiRuntime().createChatState(this.chatContext, {
      uri: conversationId,
    });
    const cachedPrefix = getCachedPrefixTurns(conversationId);
    if (cachedPrefix && cachedPrefix.length > 0) {
      this.chatState.transcript.setPrefixTurns(cachedPrefix);
      this.prefixTurnCount = cachedPrefix.length;
    }
    const cachedTurns = getCachedTranscriptSync(conversationId);
    if (cachedTurns && cachedTurns.length > 0) {
      this.chatState.transcript.history.replace(cachedTurns);
      this.historyKnown = true;
      this.historyLoading = false;
      this.messageCount = cachedTurns.length;
    }
    const pendingDraft = consumePendingDraftText(conversationId);
    if (pendingDraft) {
      this.composerModel.setText(pendingDraft);
    }
    this._draftSpace = getMementoClient().subject(conversationSubject({ conversationId }));
    this._draftHandle = this._draftSpace.handle(acpDraftMemento);
    registerConversationCommands(conversationId, () =>
      this.commands.map((command) => command.name)
    );

    makeObservable(this, {
      session: observable.ref,
      historyLoading: observable,
      sessionConnecting: observable,
      historyKnown: observable,
      loadError: observable,
      observedActivityAt: observable,
      turnActivity: computed,
      messageCount: observable,
      prefixTurnCount: observable,
      lastLimitErrorTurnId: observable,
      draftText: computed,
      draftAttachments: observable.shallow,
      unconfirmedPromptIds: observable.shallow,
      model: computed,
      modelOptions: computed,
      permissionMode: computed,
      permissionModeOptions: computed,
      collaborationMode: computed,
      collaborationModeOptions: computed,
      effort: computed,
      effortOptions: computed,
      commands: computed,
      mcpServers: computed,
      agents: computed,
      runningAgentCount: computed,
      permissionQueue: computed,
      queuedPrompts: computed,
      usage: computed,
      affordances: computed,
      supportsSteering: computed,
      isEmpty: computed,
      submitPrompt: action,
      stop: action,
      setModel: action,
      setMode: action,
      setCollaborationMode: action,
      setEffort: action,
      resolvePermission: action,
      editQueuedPrompt: action,
      deleteQueuedPrompt: action,
      reorderQueuedPrompts: action,
      sendQueuedPromptNow: action,
      setDraftText: action,
      clearDraftKeepingAttachments: action,
      addDraftAttachments: action,
      removeDraftAttachment: action,
      exportTranscript: action,
      retry: action,
      retryStalledTurn: action,
    });
    this._disposeComposerSubscription = this.composerModel.subscribe(() => {
      runInAction(() => this._draftText.set(this.composerModel.getText()));
    });
    const initialHost = this.hostAccess?.state;
    this._attachedHostGeneration =
      initialHost?.kind === 'ready' ? initialHost.hostGeneration : undefined;
    this._disposeHostReaction = reaction(
      () => this.hostAccess?.state,
      (state) => {
        const kind = state?.kind;
        if (state?.kind === 'ready') {
          const changed = state.hostGeneration !== this._attachedHostGeneration;
          const session = this.session;
          if (session && (changed || !session.usable)) {
            this._recoverAttachment(session, state.hostGeneration);
          }
        } else {
          void this._attachmentRecovery?.dispose();
          this._attachmentRecovery = null;
        }
        if (
          kind === 'ready' &&
          !this.session &&
          this._bootstrapped &&
          !this.historyLoading &&
          this.loadError?.kind === 'unavailable'
        ) {
          this.historyLoading = true;
          this.loadError = null;
          void this._runBootstrap();
        }
      }
    );
    this._disposeUsageReaction = reaction(
      () => this.usage,
      (u) => {
        if (!u || this._disposed) return;
        const costAmount = u.cost?.amount ?? 0;
        if (!this._hasInitializedUsageBaseline) {
          this._hasInitializedUsageBaseline = true;
          this._lastRecordedContextUsed = u.contextUsed;
          this._lastRecordedCostUsd = costAmount;
          return;
        }
        const tokensDelta =
          u.contextUsed > this._lastRecordedContextUsed
            ? u.contextUsed - this._lastRecordedContextUsed
            : 0;
        this._lastRecordedContextUsed = u.contextUsed;
        const costUsdDelta =
          costAmount > this._lastRecordedCostUsd ? costAmount - this._lastRecordedCostUsd : 0;
        if (costAmount > this._lastRecordedCostUsd) {
          this._lastRecordedCostUsd = costAmount;
        }
        if (tokensDelta === 0 && costUsdDelta === 0) return;

        const convData = conversationRegistry
          .get(this.taskId)
          ?.conversations.get(this.conversationId)?.data;
        const providerId = convData?.providerId;
        if (!providerId) return;

        void getUsageLimitsClient()
          .then((client) =>
            client.recordUsage({
              conversationId: this.conversationId,
              projectId: this.projectId,
              providerId,
              ...(this.model ? { model: this.model } : {}),
              ...(tokensDelta > 0 ? { tokensDelta } : {}),
              ...(costUsdDelta > 0 ? { costUsdDelta } : {}),
            })
          )
          .catch(() => {});
      }
    );
    this._draftHandle.autoPersist(
      () => ({
        version: '1' as const,
        text: this.draftText.slice(0, ACP_DRAFT_MAX_LENGTH),
        attachments: this.draftAttachments.map(({ ref }) => ({
          id: ref.id,
          mimeType: ref.mimeType,
          name: ref.name,
        })),
      }),
      this._scope
    );
    void this._draftSpace.ready.then(
      () => {
        runInAction(() => {
          if (this._disposed || this.draftText !== '' || this.draftAttachments.length > 0) return;
          const stored = this._draftHandle.value;
          this.composerModel.setText(stored.text);
          this.draftAttachments = stored.attachments.map((attachment) => ({
            ref: { type: 'attachment', ...attachment },
          }));
        });
        void this._rehydrateDraftAttachmentPreviews();
      },
      (error: unknown) => getMementoClient().reportError(error)
    );
  }

  get model(): string | null {
    return this.session?.config?.current().modelOptions?.selected ?? null;
  }

  get modelOptions(): Record<string, ComposerModelOption> | null {
    const options = this.session?.config?.current().modelOptions;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        {
          name: localizeAgentLabel(option.name),
          description: localizeAgentLabel(option.description),
        },
      ])
    );
  }

  get permissionMode(): string | null {
    return this.session?.config?.current().modeOptions?.selected ?? null;
  }

  get permissionModeOptions(): Record<string, ComposerPermissionModeOption> | null {
    const options = this.session?.config?.current().modeOptions;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        {
          name: localizeAgentLabel(option.name),
          description: localizeAgentLabel(option.description),
        },
      ])
    );
  }

  get collaborationMode(): string | null {
    return this.session?.config?.current().collaborationModeOptions?.selected ?? null;
  }

  get collaborationModeOptions(): Record<string, ComposerCollaborationModeOption> | null {
    const options = this.session?.config?.current().collaborationModeOptions;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        {
          name: localizeAgentLabel(option.name),
          description: localizeAgentLabel(option.description),
        },
      ])
    );
  }

  get effort(): string | null {
    return this.session?.config?.current().efforts?.selected ?? null;
  }

  get effortOptions(): Record<string, ComposerEffortOption> | null {
    const options = this.session?.config?.current().efforts;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        {
          name: localizeAgentLabel(option.name),
          description: localizeAgentLabel(option.description),
        },
      ])
    );
  }

  get commands(): CommandItem[] {
    return (this.session?.config?.current().availableCommands ?? []).map((command) => ({
      id: command.name,
      name: command.name,
      description: command.description,
      behavior: 'insert',
    }));
  }

  get mcpServers(): SessionMcpServer[] {
    return this.session?.mcpServers.current() ?? [];
  }

  get agents(): readonly AgentState[] {
    return this.session?.agents.current() ?? [];
  }

  get runningAgentCount(): number {
    return this.agents.filter((agent) => agent.status === 'running').length;
  }

  get permissionQueue(): PermissionQueueItem[] {
    return (this.session?.sessionState.current().pendingPermissions ?? []).map((request) => ({
      requestId: request.requestId,
      title: request.toolCall.title,
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: localizeAgentLabel(option.name),
        kind: option.kind,
      })),
    }));
  }

  get queuedPrompts(): ComposerQueuedPrompt[] {
    return this._queuedPromptModels().map((prompt) => ({
      id: prompt.id,
      text: prompt.text,
    }));
  }

  get usage(): {
    contextUsed: number;
    contextSize: number;
    cost?: { amount: number; currency: string } | null;
  } | null {
    return this.session?.usage.current() ?? null;
  }

  get affordances(): AgentAffordances {
    const state = this.session?.sessionState.current();
    const liveActionsEnabled = this.liveActionsEnabled;
    const isResuming = state?.lifecycle === 'starting' || state?.lifecycle === 'replaying';
    return {
      isWorking: state?.isGenerating ?? false,
      isBusy: state?.isGenerating ?? false,
      isResuming,
      hasPendingPermission: (state?.pendingPermissions.length ?? 0) > 0,
      canSubmit: liveActionsEnabled && (state?.canSubmit ?? false),
      canCancel: liveActionsEnabled && (state?.canCancel ?? false),
    };
  }

  get liveActionsEnabled(): boolean {
    return this.hostAccess?.liveAction.kind !== 'disabled' && (this.session?.usable ?? false);
  }

  /** Runtime-reported liveness of the running turn; see `turn-liveness.ts`. */
  get turnActivity():
    | { turnStartedAt: number; lastActivityAt: number; backgroundTasks?: number }
    | undefined {
    return this.session?.sessionState.current().activity;
  }

  /** The runtime's live turn (authoritative after reconnects, unlike local view state). */
  liveTurn(): RuntimeTranscriptTurn | null {
    return this.session?.activeTurn.current() ?? null;
  }

  get supportsSteering(): boolean {
    return this.session?.sessionState.current().supportsSteering === true;
  }

  /** Ekrandaki (yüklenmiş) turlar; sohbet çatallama geçmişi okunamazsa yedek olarak kullanır. */
  visibleTurns(): readonly HandoffTurn[] {
    const state = this.chatState.transcript.state;
    const active = state.activeTurnSnapshot;
    return [...state.displayTurns, ...(active ? [active] : [])];
  }

  get isEmpty(): boolean {
    return this.historyKnown && this.messageCount === 0;
  }

  bootstrap(): void {
    if (this._bootstrapped) return;
    this._bootstrapped = true;
    void this._runBootstrap();
  }

  retry(): void {
    if (this.hostAccess?.liveAction.kind === 'disabled') {
      void this.hostAccess.recover();
      return;
    }
    if (this.session && !this._bootstrapFailed) {
      const state = this.hostAccess?.state;
      this._recoverAttachment(
        this.session,
        state?.kind === 'ready' ? state.hostGeneration : undefined
      );
      return;
    }
    if (this.historyLoading || !this.loadError) return;
    void this._attachmentRecovery?.dispose();
    this._attachmentRecovery = null;
    this.historyLoading = !this.historyKnown && this.messageCount === 0;
    this.loadError = null;
    void this._runBootstrap();
  }

  bindView(view: ChatView | null): void {
    this._view = view;
  }

  async uploadAttachment(input: AcpAttachmentUploadInput): Promise<AttachmentRef | null> {
    if (this.hostAccess?.liveAction.kind === 'disabled') return null;
    try {
      const client = await this._getAttachmentsClient();
      const result = await client.upload(
        { conversationId: this.conversationId },
        {
          name: input.name ?? 'attachment',
          mimeType: input.mimeType,
          size: input.size ?? input.data?.byteLength,
          source: input.source ?? singleChunk(input.data),
        }
      );
      if (!result.success) {
        this._toastError('Failed to upload attachment', result.error);
        return null;
      }
      return result.data;
    } catch (error) {
      this._toastError('Failed to upload attachment', error);
      return null;
    }
  }

  async downloadAttachment(id: string) {
    const client = await this._getAttachmentsClient();
    const result = await client.download({
      conversationId: this.conversationId,
      attachmentId: id,
    });
    if (!result.success) return result;
    return {
      success: true as const,
      data: {
        ref: result.data.meta,
        data: await result.data.bytes(),
      },
    };
  }

  async deleteAttachment(id: string): Promise<void> {
    try {
      const client = await this._getAttachmentsClient();
      const result = await client.delete({
        conversationId: this.conversationId,
        attachmentId: id,
      });
      if (!result.success) this._toastError('Failed to delete attachment', result.error);
    } catch (error) {
      this._toastError('Failed to delete attachment', error);
    }
  }

  submitPrompt(
    text: string,
    attachments: AcpPromptAttachment[] = [],
    hiddenContext?: string | Promise<string | undefined>,
    placement?: PromptPlacement
  ): void {
    if (this.hostAccess?.liveAction.kind === 'disabled') return;
    const promptAttachments = attachments.map((attachment) => attachment.ref);
    const submissionSequence = ++this._submissionSequence;
    const promptId = crypto.randomUUID();
    let optimisticId: string | undefined;
    this.composerModel.clear();
    this.draftAttachments = [];
    if (!this.affordances.isWorking) {
      optimisticId = promptId;
      this.chatState.session.setPendingPrompt({
        id: optimisticId,
        text,
        attachments: attachments.map(toPendingAttachment),
      });
      this._syncMessageCount();
      // A sent prompt stays at the bottom and the view follows the reply as it streams, like a
      // normal chat; it is not lifted to the top of the viewport.
      const followMode = { kind: 'tail' } as const;
      this._view?.setScrollMode(followMode);
      this.chatState.scroll.set(followMode);
    }

    void this._submitPrompt(promptId, text, promptAttachments, hiddenContext, placement).then(
      (outcome) => {
        if (outcome !== 'rejected') return;
        runInAction(() => {
          if (this._disposed || submissionSequence !== this._submissionSequence) return;
          if (optimisticId && this.chatState.session.state.pendingPrompt?.id === optimisticId) {
            this.chatState.session.setPendingPrompt(null);
            this._syncMessageCount();
          }
          if (this.draftText !== '' || this.draftAttachments.length > 0) return;
          this.composerModel.setText(text);
          this.draftAttachments = attachments;
        });
      }
    );
  }

  setDraftText(text: string): void {
    this.composerModel.setText(text);
  }

  /** Clears the draft without deleting its uploaded attachments (the prompt stash keeps them). */
  clearDraftKeepingAttachments(): void {
    this.composerModel.clear();
    this.draftAttachments = [];
  }

  addDraftAttachments(attachments: AcpPromptAttachment[]): void {
    if (attachments.length === 0) return;
    const existingIds = new Set(this.draftAttachments.map(({ ref }) => ref.id));
    const additions = attachments.filter(({ ref }) => !existingIds.has(ref.id));
    if (additions.length === 0) return;
    this.draftAttachments = [...this.draftAttachments, ...additions];
    if (additions.some((attachment) => !attachment.previewUrl)) {
      void this._rehydrateDraftAttachmentPreviews();
    }
  }

  removeDraftAttachment(id: string): void {
    const existing = this.draftAttachments.find(({ ref }) => ref.id === id);
    if (!existing) return;
    if (existing.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(existing.previewUrl);
    }
    this.draftAttachments = this.draftAttachments.filter(({ ref }) => ref.id !== id);
    void this.deleteAttachment(id);
  }

  /**
   * Ends a turn that stopped responding and asks again: the prompt is queued first, then the
   * turn is cancelled, so it runs as soon as the cancelled turn settles (no duplicate, no race).
   */
  retryStalledTurn(): void {
    if (!this.liveActionsEnabled) return;
    const text = turnPromptText(this.liveTurn());
    if (!text) {
      this.stop();
      return;
    }
    void this._submitPrompt(crypto.randomUUID(), text, [], undefined, 'queue').then((outcome) => {
      if (outcome === 'accepted') this.stop();
    });
  }

  stop(): void {
    if (!this.liveActionsEnabled) return;
    void this.session
      ?.cancelTurn()
      .then((result) => {
        if (!result.success) this._toastError('Failed to stop', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to stop', error));
  }

  async cancelSubagent(runId: string): Promise<void> {
    if (!this.liveActionsEnabled) return;
    try {
      const result = await this.session?.cancelSubagent(runId);
      if (result && !result.success) {
        this._toastError('Alt ajan durdurulamadı', result.error);
      }
    } catch (error) {
      this._toastError('Alt ajan durdurulamadı', error);
    }
  }

  setModel(model: string): void {
    if (!this.liveActionsEnabled) return;
    void this.session
      ?.setOption('model', model)
      .then((result) => {
        if (!result.success) {
          this._toastError('Failed to change model', result.error);
          return;
        }
        const syncedCollaborationMode = this.collaborationMode;
        void this._rememberPreference({
          model,
          ...(syncedCollaborationMode ? { collaborationMode: syncedCollaborationMode } : {}),
        });
      })
      .catch((error: unknown) => this._toastError('Failed to change model', error));
  }

  setMode(modeId: string): void {
    if (!this.liveActionsEnabled) return;
    void this.session
      ?.setOption('mode', modeId)
      .then((result) => {
        if (!result.success) {
          this._toastError('Failed to change session mode', result.error);
          return;
        }
        void this._rememberPreference({ modeId });
      })
      .catch((error: unknown) => this._toastError('Failed to change session mode', error));
  }

  setCollaborationMode(modeId: string): void {
    if (!this.liveActionsEnabled) return;
    void this.session
      ?.setOption('collaborationMode', modeId)
      .then((result) => {
        if (!result.success) {
          this._toastError('Failed to change collaboration mode', result.error);
          return;
        }
        const syncedModel = this.model;
        void this._rememberPreference({
          collaborationMode: modeId,
          ...(syncedModel ? { model: syncedModel } : {}),
        });
      })
      .catch((error: unknown) => this._toastError('Failed to change collaboration mode', error));
  }

  setEffort(effort: string): void {
    if (!this.liveActionsEnabled) return;
    void this.session
      ?.setOption('effort', effort)
      .then((result) => {
        if (!result.success) {
          this._toastError('Failed to change effort', result.error);
          return;
        }
        void this._rememberPreference({ effort });
      })
      .catch((error: unknown) => this._toastError('Failed to change effort', error));
  }

  setModelAndEffort(model: string, effort: string): void {
    if (!this.liveActionsEnabled) return;
    const session = this.session;
    if (!session) return;
    void (async () => {
      if (model !== this.model) {
        const modelResult = await session.setOption('model', model);
        if (!modelResult.success) {
          this._toastError('Failed to change model', modelResult.error);
          return;
        }
        void this._rememberPreference({ model });
      }
      // Yeni seçilen modelin desteklediği efor düzeyleri farklı olabilir (ör. bazı modellerde ultra yoktur).
      const availableEfforts = session.config.current().efforts?.available ?? [];
      let resolvedEffort: string | null = effort;
      if (availableEfforts.length > 0 && !availableEfforts.some((o) => o.id === effort)) {
        const fallbackOrder = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'default'];
        const requestedIndex = fallbackOrder.indexOf(effort.toLowerCase());
        const candidates =
          requestedIndex >= 0 ? fallbackOrder.slice(requestedIndex + 1) : fallbackOrder;
        resolvedEffort =
          candidates.find((id) => availableEfforts.some((o) => o.id === id)) ??
          availableEfforts[availableEfforts.length - 1]?.id ??
          null;
      }
      if (!resolvedEffort || resolvedEffort === this.effort) return;
      const effortResult = await session.setOption('effort', resolvedEffort);
      if (!effortResult.success) {
        this._toastError('Failed to change effort', effortResult.error);
        return;
      }
      void this._rememberPreference({ effort: resolvedEffort });
    })().catch((error: unknown) => this._toastError('Failed to change model', error));
  }

  resolvePermission(optionId: string): void {
    if (!this.liveActionsEnabled) return;
    const request = this.permissionQueue[0];
    if (!request) return;
    void this.session?.resolvePermission(request.requestId, optionId);
  }

  editQueuedPrompt(id: string, text: string): void {
    if (!this.liveActionsEnabled) return;
    const existing = this._queuedPromptModels().find((prompt) => prompt.id === id);
    if (!existing) return;
    const input: PromptInput = {
      text,
      hiddenContext: existing.hiddenContext,
      attachments: existing.attachments,
    };
    void this.session
      ?.editQueuedPrompt(id, input)
      .then((result) => {
        if (!result.success) this._toastError('Failed to edit queued prompt', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to edit queued prompt', error));
  }

  deleteQueuedPrompt(id: string): void {
    if (!this.liveActionsEnabled) return;
    void this.session
      ?.deleteQueuedPrompt(id)
      .then((result) => {
        if (!result.success) this._toastError('Failed to delete queued prompt', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to delete queued prompt', error));
  }

  reorderQueuedPrompts(ids: string[]): void {
    if (!this.liveActionsEnabled) return;
    void this.session
      ?.changeQueuePromptOrder(ids)
      .then((result) => {
        if (!result.success) this._toastError('Failed to reorder queued prompts', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to reorder queued prompts', error));
  }

  sendQueuedPromptNow(id: string): void {
    if (!this.liveActionsEnabled) return;
    void this._sendQueuedPromptNow(id);
  }

  exportTranscript(kind: 'parsed' | 'raw'): void {
    void this._exportTranscript(kind);
  }

  dispose(): void {
    const committed = this.chatState.transcript.state.committedTurns;
    if (committed.length > 0) {
      saveCachedTranscript(this.conversationId, committed);
    }
    this._disposed = true;
    this._disposeHostReaction();
    this._disposeUsageReaction();
    unregisterConversationCommands(this.conversationId);
    this._unsubs.splice(0).forEach((unsub) => unsub());
    this.session?.dispose();
    this.chatState.dispose();
    this._disposeComposerSubscription();
    this.composerModel.dispose();
    void this._scope
      .dispose()
      .then(() => this._draftSpace.release())
      .catch((error: unknown) => getMementoClient().reportError(error));
  }

  private async _hydrateInlineHandoffPrefix(): Promise<void> {
    if (this._disposed || this.prefixTurnCount > 0) return;
    await initHandoffPersistence().catch(() => {});
    if (this._disposed || this.prefixTurnCount > 0) return;
    const record = getHandoffStore().get(this.conversationId);
    if (!record) return;
    const isInline = record.mode === 'inline-handoff' && Boolean(record.chain?.length);
    const isFork = record.mode === 'fork' && Boolean(record.sourceConversationId);
    if (!isInline && !isFork) return;
    const cached = getCachedPrefixTurns(this.conversationId);
    if (cached && cached.length > 0) {
      runInAction(() => {
        if (this._disposed) return;
        this.chatState.transcript.setPrefixTurns(cached);
        this.prefixTurnCount = cached.length;
      });
      return;
    }
    try {
      const acpClient = (await getConversationsClient()).acp;
      const loadHistoryPage = (segmentConvId: string, before: number | undefined) =>
        acpClient.loadHistory({
          conversationId: segmentConvId,
          limit: 100,
          ...(before === undefined ? {} : { before }),
        }) as Promise<
          | {
              success: true;
              data: {
                turns: readonly TranscriptTurn[];
                nextCursor: number | null;
                unavailable?: true;
              };
            }
          | { success: false; error: unknown }
        >;

      const prefixTurns = isFork
        ? await resolveForkAncestorPrefixTurns(this.conversationId, {
            getRecord: (id) => getHandoffStore().get(id),
            loadHistoryPage,
          })
        : await hydrateChainPrefixTurns(record.chain!, loadHistoryPage);

      if (this._disposed || prefixTurns.length === 0) return;
      setCachedPrefixTurns(this.conversationId, prefixTurns);
      runInAction(() => {
        if (this._disposed) return;
        this.chatState.transcript.setPrefixTurns(prefixTurns);
        this.prefixTurnCount = prefixTurns.length;
      });
    } catch (error) {
      log.warn('Failed to hydrate prefix history', {
        conversationId: this.conversationId,
        error,
      });
    }
  }

  private async _hydrateFromDiskCache(epoch: number): Promise<void> {
    if (this._disposed || this.messageCount > 0) return;
    const applyFastTurns = (turns: readonly TranscriptTurn[], persistToIndexedDb: boolean) => {
      if (
        this._disposed ||
        this._historyEpoch !== epoch ||
        turns.length === 0 ||
        this.chatState.transcript.state.committedTurns.length > 0
      ) {
        return false;
      }
      runInAction(() => {
        if (this._disposed || this.chatState.transcript.state.committedTurns.length > 0) return;
        this.chatState.transcript.history.replace(turns);
        this.historyKnown = true;
        this.historyLoading = false;
        this._syncMessageCount();
      });
      if (persistToIndexedDb) {
        saveCachedTranscript(this.conversationId, turns);
      }
      return true;
    };

    try {
      const idbTurns = await loadCachedTranscript(this.conversationId);
      if (idbTurns && idbTurns.length > 0 && applyFastTurns(idbTurns, false)) {
        return;
      }
    } catch {
      // IndexedDB okunamazsa ana süreç önbelleğine geç.
    }

    if (
      this._disposed ||
      this._historyEpoch !== epoch ||
      this.chatState.transcript.state.committedTurns.length > 0
    ) {
      return;
    }

    // Ana süreç SQLite kv / yerel disk günlüğü / FTS önbelleğinden CLI açmadan (<15 ms) oku.
    try {
      const acpClient = (await getConversationsClient()).acp as {
        getCachedHistory?: (input: { conversationId: string }) => Promise<{
          turns: TranscriptTurn[];
          source: string;
        }>;
      };
      if (typeof acpClient?.getCachedHistory !== 'function') return;
      const cached = await runWithTimeout(
        () => acpClient.getCachedHistory!({ conversationId: this.conversationId }),
        { timeoutMs: 2_500, signal: this._scope.signal }
      );
      if (cached && Array.isArray(cached.turns) && cached.turns.length > 0) {
        applyFastTurns(cached.turns, true);
      }
    } catch {
      // Hızlı önbellek okunamazsa canlı yükleme normal akışında sürer.
    }
  }

  private async _runBootstrap(): Promise<void> {
    const epoch = ++this._historyEpoch;
    if (this._disposed) return;
    void this._hydrateInlineHandoffPrefix();
    void this._hydrateFromDiskCache(epoch);
    if (this.hostAccess?.liveAction.kind === 'disabled') {
      runInAction(() => {
        this.sessionConnecting = false;
        this.historyLoading = false;
        this.loadError = {
          kind: 'unavailable',
          message: 'Proje erişimi dönene kadar canlı sohbet kullanılamıyor.',
        };
      });
      return;
    }
    runInAction(() => {
      this.sessionConnecting = true;
    });
    const providerId = conversationRegistry.get(this.taskId)?.conversations.get(this.conversationId)
      ?.data.providerId;
    let clientSession: AcpLiveSession | null = null;
    try {
      const attachedSession = await AcpLiveSession.create(this.conversationId, this._scope.signal);
      clientSession = attachedSession;
      if (this._disposed || this._historyEpoch !== epoch) {
        attachedSession.dispose();
        return;
      }

      runInAction(() => {
        this.session?.dispose();
        this.session = attachedSession;
        this.sessionConnecting = false;
        this._subscribeLiveSession(attachedSession);
      });

      const history = await runWithTimeout(() => attachedSession.loadHistory(undefined, 100), {
        timeoutMs: 25_000,
        signal: this._scope.signal,
      }).catch((err: unknown) => {
        if (err instanceof TimeoutError) {
          throw new Error('Sohbet geçmişi zamanında yanıt vermedi. Tekrar deneyin.');
        }
        throw err;
      });
      if (this._disposed || this._historyEpoch !== epoch || this.session !== attachedSession)
        return;
      if (!history.success) throw new AcpStartError(history.error);
      if (history.data.unavailable && !this.historyKnown && this.messageCount === 0) {
        this._failBootstrap({
          kind: 'history_unavailable',
          message: 'Conversation history is unavailable. Retry loading this conversation.',
        });
        return;
      }
      if (history.data.clearedConfiguration?.length) {
        await this._rememberPreference(
          Object.fromEntries(history.data.clearedConfiguration.map((key) => [key, null])) as {
            model?: null;
            modeId?: null;
            effort?: null;
            collaborationMode?: null;
          }
        );
      }

      if (this._disposed || this._historyEpoch !== epoch || this.session !== attachedSession)
        return;
      this._announceClearedModel(history.data);
      runInAction(() => {
        const applied = this.chatState.transcript.applyPage(history.data);
        if (applied) this.historyKnown = true;
        this.historyLoading = false;
        this.loadError = null;
        this._bootstrapFailed = false;
        this._syncMessageCount();
      });
      const committed = this.chatState.transcript.state.committedTurns;
      if (committed.length > 0) {
        saveCachedTranscript(this.conversationId, committed);
      }
      const handoffRecord = getHandoffStore().get(this.conversationId);
      if (
        handoffRecord?.targetEffort &&
        this.effortOptions?.[handoffRecord.targetEffort] &&
        this.effort !== handoffRecord.targetEffort
      ) {
        this.setEffort(handoffRecord.targetEffort);
        getHandoffStore().clearTargetEffort(this.conversationId);
      }
      if (this._historyRefreshRequested || this.chatState.transcript.needsHistory)
        this._requestHistoryRefresh();
      void this._rehydrateDraftAttachmentPreviews();
    } catch (error) {
      if (this._disposed || this._historyEpoch !== epoch) {
        if (clientSession && this.session !== clientSession) clientSession.dispose();
        return;
      }
      log.error('ACP chat bootstrap failed', {
        conversationId: this.conversationId,
        projectId: this.projectId,
        taskId: this.taskId,
        error,
      });
      if (clientSession && this.session !== clientSession) clientSession.dispose();
      this._failBootstrap(toLoadError(error));
      if (this.loadError?.kind === 'auth_required' && providerId) {
        void this._refreshAuthStatus(providerId);
      }
    }
  }

  private _failBootstrap(error: AcpLoadError): void {
    runInAction(() => {
      this._bootstrapFailed = true;
      this.sessionConnecting = false;
      this.historyLoading = false;
      this.loadError =
        this.hostAccess?.liveAction.kind === 'disabled'
          ? {
              kind: 'unavailable',
              message: 'Live chat is unavailable until Project access returns.',
            }
          : error;
    });
  }

  private _recoverAttachment(session: AcpLiveSession, generation: number | undefined): void {
    this._historyEpoch++;
    void this._attachmentRecovery?.dispose();
    const scope = this._scope.child('attachment-recovery');
    this._attachmentRecovery = scope;
    void scope
      .run('reattach', async () => {
        let attempt = 0;
        while (!scope.signal.aborted && this.session === session) {
          try {
            await session.revalidate(scope.signal);
            if (scope.signal.aborted || this.session !== session || !session.usable) return;
            this._attachedHostGeneration = generation;
            this._historyRefreshTrigger?.reset();
            runInAction(() => {
              // Reattachment alone cannot recover a failed history/bootstrap load.
              if (this._bootstrapFailed || (this._bootstrapped && this.historyLoading)) {
                this.historyLoading = true;
                this.loadError = null;
                void this._runBootstrap();
              } else {
                this.loadError = null;
                this._requestHistoryRefresh();
              }
            });
            return;
          } catch (error) {
            if (scope.signal.aborted || this.session !== session) return;
            const loadError = toLoadError(error);
            runInAction(() => {
              this.loadError = loadError;
            });
            if (loadError.kind === 'auth_required') return;
          }
          await systemClock.sleep(Math.min(1_000 * 2 ** attempt++, 15_000), {
            signal: scope.signal,
          });
        }
      })
      .exit.finally(() => {
        if (this._attachmentRecovery === scope) this._attachmentRecovery = null;
        void scope.dispose();
      });
  }

  private async _refreshAuthStatus(providerId: string): Promise<void> {
    try {
      const host = hostRefFromConnectionId(getProjectSshConnectionId(this.projectId));
      const client = await getAgentsClient();
      const result = await client.refreshAuthStatus({ host, providerId });
      if (!result.success) {
        log.warn('Failed to refresh agent auth status after ACP auth error', {
          providerId,
          error: result.error,
        });
      }
    } catch (error) {
      log.warn('Failed to refresh agent auth status after ACP auth error', {
        providerId,
        error,
      });
    }
  }

  private _queuedPromptModels(): QueuedPrompt[] {
    return this.session?.sessionState.current().queuedPrompts ?? [];
  }

  private async _submitPrompt(
    promptId: string,
    text: string,
    attachments: StoredPromptAttachment[],
    hiddenContext?: string | Promise<string | undefined>,
    placement?: PromptPlacement
  ): Promise<'accepted' | 'rejected' | 'unknown'> {
    if (this.hostAccess?.liveAction.kind === 'disabled') return 'rejected';
    const session = this.session;
    if (!session || !session.usable) {
      this._toastError('Failed to send message', new Error('ACP session is not connected'));
      return 'rejected';
    }

    let resolvedHiddenContext: string | undefined;
    try {
      resolvedHiddenContext = await hiddenContext;
    } catch (error) {
      log.warn('Failed to resolve issue context for ACP prompt', {
        conversationId: this.conversationId,
        error,
      });
    }

    try {
      const result = await session.sendPrompt(
        {
          text,
          ...(resolvedHiddenContext ? { hiddenContext: resolvedHiddenContext } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        placement,
        promptId
      );
      if (!result.success) {
        this._toastError('Failed to send message', result.error);
        return 'rejected';
      }
      getHandoffStore().markContextDelivered(this.conversationId);
      return 'accepted';
    } catch (error) {
      if (error instanceof AcpPromptDeliveryUnknownError) {
        if (this._disposed) return 'unknown';
        runInAction(() => {
          this.unconfirmedPromptIds = [...this.unconfirmedPromptIds, error.promptId];
          this._syncMessageCount();
        });
        return 'unknown';
      }
      this._toastError('Failed to send message', error);
      return 'rejected';
    }
  }

  private async _sendQueuedPromptNow(id: string): Promise<void> {
    const current = this._queuedPromptModels();
    if (!current.some((prompt) => prompt.id === id)) return;

    const shouldCancelActiveTurn = this.affordances.isWorking;
    const ids = [id, ...current.map((prompt) => prompt.id).filter((promptId) => promptId !== id)];
    const reorderResult = await this.session?.changeQueuePromptOrder(ids);
    if (!reorderResult?.success) {
      this._toastError('Failed to send queued prompt', reorderResult?.error);
      return;
    }

    if (!shouldCancelActiveTurn) return;
    const cancelResult = await this.session?.cancelTurn();
    if (!cancelResult?.success) {
      this._toastError('Failed to send queued prompt', cancelResult?.error);
    }
  }

  private async _exportTranscript(kind: 'parsed' | 'raw'): Promise<void> {
    const session = this.session;
    if (!session) {
      this._toastError('Failed to export transcript', new Error('Chat is not loaded.'));
      return;
    }

    try {
      const result =
        kind === 'raw' ? await session.exportRawAcpLog() : await session.exportTranscript();
      if (!result.success) {
        this._toastError('Failed to export transcript', result.error);
        return;
      }

      const label = kind === 'raw' ? 'raw ACP log' : 'parsed transcript';
      const suffix = kind === 'raw' ? 'acp-raw' : 'transcript';
      const saved = await (
        await getHostClient()
      ).saveTextFile({
        title: `Export ${label}`,
        defaultPath: `${this.conversationId}-${suffix}.json`,
        content: result.data,
      });
      if (!saved.success) {
        this._toastError('Failed to save transcript', new Error(saved.error));
        return;
      }
      if (!saved.path) return;
      toast(`Exported ${label}`);
    } catch (error) {
      this._toastError('Failed to export transcript', error);
    }
  }

  private _subscribeLiveSession(session: AcpLiveSession): void {
    this._unsubs.splice(0).forEach((unsub) => unsub());
    const refreshTrigger = new HistoryRefreshTrigger(session.sessionState.current());
    this._historyRefreshTrigger = refreshTrigger;
    let wasGenerating = session.sessionState.current().isGenerating;
    // The local fallback clock starts at attach: a turn already running is at least this alive.
    this.observedActivityAt = wasGenerating ? Date.now() : null;
    const disconnectChatSession = getChatUiRuntime().connectSession(
      this.chatState,
      {
        activeTurn: asValueSource(session.activeTurn),
        plan: asValueSource(session.plan),
        sessionState: asValueSource(session.sessionState),
      },
      {
        onTurnCommitted: () => this._requestHistoryRefresh(),
      }
    );
    this._syncMessageCount();
    this._unsubs.push(
      disconnectChatSession,
      this._bindTerminalOutputs(session),
      session.sessionState.onChange((state) => {
        const refresh = refreshTrigger.observe(state, this.historyLoading);
        runInAction(() => {
          if (state.isGenerating && !wasGenerating) this.observedActivityAt = Date.now();
          wasGenerating = state.isGenerating;
          this._syncMessageCount();
        });
        if (refresh) this._requestHistoryRefresh();
      }),
      session.activeTurn.onChange(() =>
        runInAction(() => {
          this.observedActivityAt = Date.now();
          this._syncMessageCount();
        })
      )
    );
  }

  private async _rehydrateDraftAttachmentPreviews(): Promise<void> {
    const pending = this.draftAttachments.filter(
      (attachment) =>
        !attachment.previewUrl &&
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.ref.mimeType)
    );
    await Promise.all(
      pending.map(async (attachment) => {
        const previewUrl = await resolveDraftAttachmentDataUrl(
          this.conversationId,
          this,
          attachment.ref.id
        );
        runInAction(() => {
          if (this._disposed) return;
          const current = this.draftAttachments.find(({ ref }) => ref.id === attachment.ref.id);
          if (!current || current.previewUrl) return;
          if (previewUrl.kind === 'resolved') {
            this.draftAttachments = this.draftAttachments.map((candidate) =>
              candidate.ref.id === attachment.ref.id
                ? { ...candidate, previewUrl: previewUrl.dataUrl }
                : candidate
            );
          } else if (previewUrl.kind === 'not_found') {
            this.draftAttachments = this.draftAttachments.filter(
              ({ ref }) => ref.id !== attachment.ref.id
            );
          }
        });
      })
    );
  }

  private _getAttachmentsClient(): Promise<ConversationsClient['attachments']> {
    this._attachmentsClientPromise ??= getConversationsClient().then(
      (client) => client.attachments
    );
    return this._attachmentsClientPromise;
  }

  private async _rememberPreference(patch: {
    model?: string | null;
    modeId?: string | null;
    effort?: string | null;
    collaborationMode?: string | null;
  }): Promise<void> {
    const providerId = conversationRegistry.get(this.taskId)?.conversations.get(this.conversationId)
      ?.data.providerId;
    if (!providerId) return;
    const host = formatHostRef(hostRefFromConnectionId(getProjectSshConnectionId(this.projectId)));
    try {
      await updateProviderPreference(host, providerId, 'acp', patch);
    } catch (error) {
      getMementoClient().reportError(error);
    }
  }

  /**
   * Tells the user once when the session dropped their retained model. The runtime repeats the
   * report while the model stays unset; the shared tracker keeps reopening the conversation or
   * refreshing its history from announcing the same clearing again.
   */
  private _announceClearedModel(report: ClearedSelectionReport): void {
    const notice = clearedModelNotices.take(this.conversationId, report);
    if (!notice) return;
    void this._clearedModelName(notice.modelId).then((name) => {
      toast.warning(clearedModelNoticeMessage(name), {
        id: `acp-cleared-model:${this.conversationId}`,
      });
    });
  }

  private async _clearedModelName(modelId: string | null): Promise<string | null> {
    if (!modelId) return null;
    const providerId = conversationRegistry.get(this.taskId)?.conversations.get(this.conversationId)
      ?.data.providerId;
    if (!providerId) return modelId;
    try {
      const agents = await (await getAgentsClient()).listMetadata(undefined);
      return catalogModelName(agents, providerId, modelId);
    } catch (error) {
      log.warn('Failed to read the model catalog for a cleared ACP model', {
        conversationId: this.conversationId,
        providerId,
        error,
      });
      return modelId;
    }
  }

  private _bindTerminalOutputs(session: AcpLiveSession): () => void {
    return bindSessionTerminalOutputs(session, (terminalId, snapshot) =>
      this.chatState.session.setTerminalOutput(terminalId, snapshot)
    );
  }

  private _requestHistoryRefresh(): void {
    this._historyRefreshRequested = true;
    if (this._historyRefreshTask || this.historyLoading) return;

    const MAX_HISTORY_REFRESH_RETRIES = 3;
    const task = Promise.resolve()
      .then(async () => {
        let attempt = 0;
        while (this._historyRefreshRequested && !this._disposed && !this.historyLoading) {
          this._historyRefreshRequested = false;
          if (await this._refreshHistory()) {
            attempt = 0;
          } else {
            // A newer head arrived during the read: catch up immediately. Backoff is
            // for unavailable/failed reads, not normal transcript progress.
            if (this._historyRefreshRequested) continue;
            if (attempt >= MAX_HISTORY_REFRESH_RETRIES) break;
            this._historyRefreshRequested = true;
            await systemClock.sleep(Math.min(1_000 * 2 ** attempt++, 15_000), {
              signal: this._scope.signal,
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (!this._disposed) getMementoClient().reportError(error);
      })
      .finally(() => {
        if (this._historyRefreshTask === task) this._historyRefreshTask = null;
        if (this._historyRefreshRequested && !this._disposed) this._requestHistoryRefresh();
      });
    this._historyRefreshTask = task;
  }

  private async _refreshHistory(): Promise<boolean> {
    const session = this.session;
    const epoch = this._historyEpoch;
    if (!session || !session.usable || this.hostAccess?.liveAction.kind === 'disabled') return true;

    try {
      const transcript = this.chatState.transcript;
      const oldestVisibleSeq = transcript.state.displayTurns[0]?.seq;
      let before: number | undefined;
      let revision: number | undefined;
      let generation: string | undefined;
      do {
        const history = await session.loadHistory(before, 100);
        if (this._disposed || this.session !== session || this._historyEpoch !== epoch) return true;
        if (!history.success) throw new AcpStartError(history.error);
        // A prompt can wake a suspended session, so its first activation report may arrive here.
        this._announceClearedModel(history.data);
        if (history.data.unavailable) return !transcript.needsHistory;
        const position = history.data.position;
        // A change between pages requires another pass over the loaded range, including
        // its latest page. A newer old-page response alone cannot prove we caught up.
        if (
          before !== undefined &&
          (position?.historyRevision !== revision || position?.generation !== generation)
        )
          return false;
        revision = position?.historyRevision;
        generation = position?.generation;
        let applied = false;
        runInAction(() => {
          applied = transcript.applyPage(history.data);
          if (!applied) return;
          this._historyRefreshTrigger?.reset();
          this.historyKnown = true;
          this.loadError = null;
          this._bootstrapFailed = false;
          this._syncMessageCount();
        });
        if (!applied) return false;
        const committed = transcript.state.committedTurns;
        if (committed.length > 0) {
          saveCachedTranscript(this.conversationId, committed);
        }
        const cursor = history.data.nextCursor;
        if (
          !position ||
          cursor === null ||
          oldestVisibleSeq === undefined ||
          cursor <= oldestVisibleSeq
        )
          break;
        if (before !== undefined && cursor >= before) return false;
        before = cursor;
      } while (!this._disposed);
      return !transcript.needsHistory;
    } catch (error) {
      if (this._disposed || this.session !== session || this._historyEpoch !== epoch) return true;
      log.warn('Failed to refresh ACP history', {
        conversationId: this.conversationId,
        error,
      });
      if (error instanceof AcpStartError) {
        // The session could not be restored: show the error with its retry action and stop
        // state-driven refreshes from waking it again (see HistoryRefreshTrigger).
        this._historyRefreshTrigger?.markRestoreFailed();
        runInAction(() => {
          this.loadError = toLoadError(error);
        });
        return true;
      }
      return false;
    }
  }

  private _syncMessageCount(): void {
    const state = this.chatState.transcript.state;
    if (this.unconfirmedPromptIds.length > 0 && this.session) {
      const accepted = new Set(
        this.session.sessionState.current().queuedPrompts.map((prompt) => prompt.id)
      );
      const active = state.activeTurnSnapshot;
      for (const turn of [...state.displayTurns, ...(active ? [active] : [])]) {
        for (const item of turn.items) {
          if (item.kind === 'message' && item.promptId) accepted.add(item.promptId);
        }
      }
      this.unconfirmedPromptIds = this.unconfirmedPromptIds.filter((id) => !accepted.has(id));
    }
    const ownDisplayTurns = state.displayTurns.filter((turn) => !isPrefixTurn(turn));
    const committedCount = ownDisplayTurns.reduce((count, turn) => count + turn.items.length, 0);
    const activeCount = state.activeTurnSnapshot?.items.length ?? 0;
    const pendingPromptCount = this.chatState.session.state.pendingPrompt ? 1 : 0;
    this.messageCount = committedCount + activeCount + pendingPromptCount;
    // Tur sürerken ya da yeni istem beklerken önceki hata artık "son sonuç" değildir.
    this.lastLimitErrorTurnId =
      state.activeTurnSnapshot || pendingPromptCount > 0
        ? null
        : limitErrorTurnId(ownDisplayTurns[ownDisplayTurns.length - 1]);
  }

  private _toastError(title: string, error: unknown): void {
    toast.error(title, { description: error instanceof Error ? error.message : undefined });
  }
}

function isPrefixTurn(turn: {
  id: string;
  seq?: number;
  items: readonly { kind?: string }[];
}): boolean {
  return (
    (typeof turn.seq === 'number' && turn.seq < 0) ||
    turn.id.startsWith('seg:') ||
    turn.id.startsWith('handoff-divider:') ||
    turn.items.some((item) => item.kind === 'handoff-divider')
  );
}

function toPendingAttachment(attachment: AcpPromptAttachment): ChatImageAttachment {
  return {
    id: attachment.ref.id,
    name: attachment.ref.name ?? 'image',
    dataUrl: attachment.previewUrl,
    mimeType: attachment.ref.mimeType,
  };
}

type DraftAttachmentPreviewResult =
  | { kind: 'resolved'; dataUrl: string }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

async function resolveDraftAttachmentDataUrl(
  conversationId: string,
  store: AcpChatStore,
  attachmentId: string
): Promise<DraftAttachmentPreviewResult> {
  const cacheKey = `${conversationId}:${attachmentId}`;
  const cached = draftAttachmentDataUrlCache.get(cacheKey);
  if (cached) return { kind: 'resolved', dataUrl: cached };
  try {
    const result = await store.downloadAttachment(attachmentId);
    if (!result.success) {
      return result.error.type === 'attachment-not-found'
        ? { kind: 'not_found' }
        : { kind: 'unavailable' };
    }
    const dataUrl = `data:${result.data.ref.mimeType};base64,${bytesToBase64(result.data.data)}`;
    draftAttachmentDataUrlCache.set(cacheKey, dataUrl);
    return { kind: 'resolved', dataUrl };
  } catch {
    return { kind: 'unavailable' };
  }
}

async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function toLoadError(error: unknown): AcpLoadError {
  const message = error instanceof Error ? error.message : 'Sohbet yüklenemedi. Yeniden deneyin.';
  if (error instanceof AcpStartError && error.errorType === 'auth_required') {
    return { kind: 'auth_required', message };
  }
  return { kind: 'generic', message };
}
