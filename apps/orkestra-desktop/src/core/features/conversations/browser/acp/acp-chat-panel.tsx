import type { AttachmentRef } from '@orkestra/core/services/attachments/api';
import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import {
  ChatComposer,
  ImageViewerDialog,
  MermaidViewerDialog,
} from '@orkestra/ui/react/components';
import type {
  CommandItem,
  ComposerAgentOption,
  ComposerAttachment,
  ComposerEffortOption,
  ComposerModelOption,
  ComposerPermissionRequest,
  ComposerProviderCatalogEntry,
  ContextMentionProvider,
  MentionItem,
  PromptEditorRef,
} from '@orkestra/ui/react/components';
import { Button, toast } from '@orkestra/ui/react/primitives';
import { ArrowDown, MessageSquarePlus } from 'lucide-react';
import { observer, useObserver } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentInstallationStatuses } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { agentSupportsAcp } from '@core/primitives/agents/api';
import { ReviewFindingsSidePanel } from '@core/features/code-review/contributions/browser/review-findings-panel';
import {
  base64ToUint8Array,
  injectIntoActiveChatDraft,
  registerActiveChatDraftHandler,
  setFocusedChatConversation,
} from '@core/features/conversations/api/browser/active-chat-draft-bus';
import { ChatTranscript } from '@core/features/conversations/api/browser/chat/chat-transcript';
import type {
  ChatCommands,
  ChatView,
} from '@core/features/conversations/api/browser/chat/chat-transcript';
import {
  createTranscriptArtifactExists,
  createTranscriptArtifactResolver,
} from '@core/features/conversations/api/browser/chat/transcript-artifact-commands';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { useConnectedIssueProviders } from '@core/features/integrations/api/browser/use-connected-issue-providers';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import { getIssuesClient } from '@core/features/issues/api/browser/client';
import { usePromptLibrary } from '@core/features/library/api/browser/prompts/use-prompt-library';
import { withOrchestraConductorContext } from '@core/features/orchestra/api/browser/orchestra-client';
import { withProjectMemoryContext } from '@core/features/project-memory/api/browser/with-project-memory-context';
import {
  getProjectSshConnectionId,
  getProjectStore,
  getProjectViewStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getSearchClient } from '@core/features/search/api/client';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
// TODO(conversations-extraction): Pass task state into ACP chat instead of importing task stores.
import {
  asProvisioned,
  getRegisteredTaskData,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { DictationButton } from '@core/features/voice/contributions/browser/dictation-button';
import { SpokenRepliesControl } from '@core/features/voice/contributions/browser/spoken-replies-control';
import { openModal } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { issueMentionToken, parseIssueMentionToken } from '@core/primitives/issues/api';
import { resolveIssueMentionSource } from '@core/primitives/issues/api/issue-context';
import { linkedIssueMentionName, type LinkedIssue } from '@core/primitives/linked-issues/api';
import { log } from '@core/primitives/logging/browser/logger';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import { forkConversation, openHandoffDialog } from '../handoff/handoff-actions';
import { HandoffNotice } from '../handoff/handoff-badge';
import { composeHandoffHiddenContext, createContinueHandler } from '../handoff/handoff-continue';
import { HandoffLimitBanner } from '../handoff/handoff-limit-banner';
import { getHandoffStore } from '../handoff/handoff-store';
import {
  agentUsageBadge,
  decideLimitBanner,
  dismissalsFor,
  sortHandoffCandidates,
  suggestHandoffAgents,
} from '../handoff/handoff-suggestions';
import { getLimitDismissalStore } from '../handoff/limit-dismissal-store';
import { switchConversationProviderInPlace } from '../handoff/switch-provider-in-place';
import { useHandoffAgents } from '../handoff/use-handoff-agents';
import { localizeAgentLabel } from './agent-labels-tr';
import type { AcpChatStore, AcpPromptAttachment } from './acp-chat-store';
import type { AcpChatTabResource } from './acp-chat-tab-resource';
import { chatViewCommandForShortcut, executeChatViewCommand } from './acp-chat-view-commands';
import {
  shouldUseAcpImageAttachment,
  toAcpImageAttachmentMimeType,
  uploadDroppedFile,
} from './acp-dropped-file';
import { AcpSideChatDrawer } from './acp-side-chat-drawer';
import { AcpSubagentsPanel, AcpSubagentsTogglePill } from './acp-subagents-panel';
import { withArtifactOutputContext } from './artifact-output-context';
import { ComputerUseChip } from './computer-use-chip';
import { ContextCompactionBanner } from './context-compaction-banner';
import { buildIssueMentionHiddenContext } from './issue-mention-context';
import { PromptSuggestionsBar } from './prompt-suggestions-bar';
import { useSelectionContextMenu } from './selection-context-menu';
import { transcriptTurns } from './subagent-activity';
import {
  SubagentRunningChip,
  SubagentSidePanel,
  useOrchestraWorkerLinks,
  useRunningNativeSubagents,
  type SubagentPanelView,
  type SubagentTarget,
} from './subagent-side-panel';
import { createTranscriptFileCommands } from './transcript-file-commands';

// ── Helpers ───────────────────────────────────────────────────────────────────

const attachmentDataUrlCache = new Map<string, string>();
const ISSUE_SEARCH_MIN_LENGTH = 2;
const ISSUE_SEARCH_LIMIT = 20;
const SLASH_COMMANDS_SECTION = 'Commands';
const SLASH_PROMPTS_SECTION = 'Prompts';

const EFFORT_SUFFIX_RE =
  /\s*\((Düşük|Orta|Yüksek|Çok Yüksek|En Yüksek|Maksimum|Maks|Ultra|Low|Medium|High|XHigh|Extra High|Extra|Max)\)\s*$/i;

function staticEffortsForProvider(
  providerId: string
): Record<string, ComposerEffortOption> | null {
  switch (providerId) {
    case 'claude':
    case 'codex':
      return {
        low: { name: 'Düşük' },
        medium: { name: 'Orta' },
        high: { name: 'Yüksek' },
        xhigh: { name: 'Çok yüksek' },
        max: { name: 'En yüksek' },
      };
    case 'kimi':
      return {
        low: { name: 'Düşük' },
        high: { name: 'Yüksek' },
        max: { name: 'En yüksek' },
      };
    default:
      return null;
  }
}

function cleanDividerModelLabel(providerId: string, rawName: string): string {
  const withoutEffort = rawName.replace(EFFORT_SUFFIX_RE, '').trim();
  if (providerId === 'claude') {
    return withoutEffort.replace(/^Claude\s+/i, '').trim() || withoutEffort;
  }
  return withoutEffort || rawName;
}

function promptPreview(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function commandMatchesQuery(command: CommandItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [command.name, command.label, command.description]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(normalized));
}

function toIssueMentionItem(issue: LinkedIssue): MentionItem {
  const token = issueMentionToken(issue.provider, issue.identifier, issue);
  return {
    id: token,
    label: token,
    name: linkedIssueMentionName(issue),
    kind: 'issue',
    description: issue.title,
    icon: <IntegrationIcon provider={issue.provider} size={13} />,
  };
}

function issueMatchesQuery(issue: LinkedIssue, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [issue.identifier, issue.displayIdentifier, issue.title]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(normalized));
}

/** Map an AcpPermissionRequest to the ComposerPermissionRequest shape the UI expects. */
function toComposerPermission(
  req: AcpChatStore['permissionQueue'][number] | undefined
): ComposerPermissionRequest | null {
  if (!req) return null;
  return {
    requestId: req.requestId,
    title: req.title,
    options: req.options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    })),
  };
}

function readFileAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

async function uploadImageFile(
  store: AcpChatStore,
  file: File
): Promise<AcpPromptAttachment | null> {
  const mimeType = toAcpImageAttachmentMimeType(file);
  if (!mimeType) {
    log.warn('Dropped image type is not supported for ACP attachments', {
      name: file.name,
      type: file.type,
    });
    return null;
  }

  const previewUrl = await readFileAsDataUrl(file);
  let ref: AttachmentRef | null;
  try {
    ref = await uploadDroppedFile(store, file, mimeType);
  } catch (error) {
    log.warn('Failed to prepare ACP attachment upload', { name: file.name, error });
    toast.error('Görsel eklenemedi', {
      description: error instanceof Error ? error.message : file.name,
    });
    return null;
  }

  if (!ref) return null;
  return {
    ref: { type: 'attachment', id: ref.id, name: ref.name, mimeType },
    previewUrl,
  };
}

function toComposerAttachment(attachment: AcpPromptAttachment): ComposerAttachment {
  return {
    id: attachment.ref.id,
    name: attachment.ref.name ?? 'image',
    kind: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.ref.mimeType)
      ? 'image'
      : 'file',
    previewUrl: attachment.previewUrl,
    mimeType: attachment.ref.mimeType,
  };
}

async function resolveAttachmentDataUrl(store: AcpChatStore, id: string): Promise<string | null> {
  const cacheKey = `${store.conversationId}:${id}`;
  const cached = attachmentDataUrlCache.get(cacheKey);
  if (cached) return cached;
  try {
    const result = await store.downloadAttachment(id);
    if (!result.success) return null;
    const dataUrl = `data:${result.data.ref.mimeType};base64,${bytesToBase64(result.data.data)}`;
    attachmentDataUrlCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch (error) {
    log.warn('Failed to resolve ACP attachment', { id, error });
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// ── Composer for a single store ────────────────────────────────────────────────
//
// Keyed by conversationId to isolate view-local UI. The store owns the editor
// model so the document, selection, viewport and undo history survive remounts.

const ComposerForStore = observer(function ComposerForStore({
  store,
  composerSlot,
  onViewerOpen,
  onRegisterSubmit,
}: {
  store: AcpChatStore;
  composerSlot: HTMLElement;
  onViewerOpen: (src?: string, alt?: string) => void;
  /** Karşılama alanındaki "Kaldığı yerden devam et" düğmesi için gönderim işleyicisini bildirir. */
  onRegisterSubmit?: (submit: ((text: string) => void) | null) => void;
}) {
  const editorApiRef = useRef<PromptEditorRef | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadsPending, setUploadsPending] = useState(0);
  const { value: chatSettings } = useAppSettingsKey('chat');
  const workingTurnSubmitMode = chatSettings?.workingTurnSubmitMode ?? 'queue';
  const attachments = store.draftAttachments.map(toComposerAttachment);
  const { value: promptLibrary } = usePromptLibrary();
  const disabledReason = projectAvailabilityUi.getLiveActionDisabledReason(store.projectId);

  // Autofocus when the slot becomes available.
  useEffect(() => {
    editorApiRef.current?.focus();
  }, [composerSlot]);

  const buildHiddenIssueContext = useCallback(
    (value: string) =>
      buildIssueMentionHiddenContext(value, async (target) => {
        const source = resolveIssueMentionSource(
          target,
          getRegisteredTaskData(store.projectId, store.taskId)?.linkedIssue
        );
        if (!source) return null;
        const result = await (
          await getIssuesClient()
        ).getIssueContext({
          provider: target.provider,
          options: {
            identifier: source.identifier,
            accountId: source.accountId,
            issueUrl: source.issueUrl,
            projectId: store.projectId,
          },
        });
        if (!result.success) {
          log.warn('Failed to resolve issue mention context', {
            token: target.token,
            error: result.error,
          });
          return null;
        }
        return result.data;
      }),
    [store.projectId, store.taskId]
  );

  const handleSubmit = useCallback(
    (value: string) => {
      if (uploadsPending > 0) return;
      const promptAttachments = store.draftAttachments;
      if (!value.trim() && promptAttachments.length === 0) return;
      const isFirstOwnPrompt = store.messageCount === 0;
      const issueContext = buildHiddenIssueContext(value);
      // An Orkestra conductor's first prompt carries the playbook as hidden context.
      const conductorContext = isFirstOwnPrompt
        ? withProjectMemoryContext(
            store.projectId,
            withOrchestraConductorContext(store.conversationId, issueContext)
          )
        : issueContext;
      // Devredilen/çatallanan sohbetlerde ilk kullanıcı mesajında bağlam özeti gizli bağlam olarak gider;
      // mesaj reddedilirse `contextDelivered` false kaldığı için yeniden denemede tekrar eklenir.
      const handoffRecord = getHandoffStore().get(store.conversationId);
      const handoffContext =
        isFirstOwnPrompt && handoffRecord?.context && !handoffRecord.contextDelivered
          ? handoffRecord.context
          : undefined;
      const hiddenContext = handoffContext
        ? Promise.resolve(conductorContext).then((existing) =>
            composeHandoffHiddenContext(handoffContext, existing)
          )
        : conductorContext;
      store.submitPrompt(value, promptAttachments, withArtifactOutputContext(hiddenContext));
    },
    [store, buildHiddenIssueContext, uploadsPending]
  );

  const handleSubmitWhileWorking = useCallback(
    (value: string) => {
      if (uploadsPending > 0) return;
      handleSubmit(value);
      if (workingTurnSubmitMode === 'steer-cancel') {
        setTimeout(() => {
          store.stop();
        }, 40);
      }
    },
    [uploadsPending, handleSubmit, workingTurnSubmitMode, store]
  );

  useEffect(() => {
    onRegisterSubmit?.(handleSubmit);
    return () => onRegisterSubmit?.(null);
  }, [handleSubmit, onRegisterSubmit]);

  const handleStop = useCallback(() => {
    store.stop();
  }, [store]);

  const handleResolvePermission = useCallback(
    (optionId: string | null) => {
      if (!optionId) return;
      store.resolvePermission(optionId);
    },
    [store]
  );

  const handleSendQueuedPromptNow = useCallback(
    (id: string) => {
      if (!store.affordances.isWorking) {
        store.sendQueuedPromptNow(id);
        return;
      }
      void openModal('confirmActionModal', {
        title: 'Turn in progress',
        description: 'Send this queued prompt now and cancel the active turn?',
        confirmLabel: 'Cancel & Send',
        variant: 'destructive',
      }).then((outcome) => {
        if (outcome.success) {
          store.sendQueuedPromptNow(id);
        }
      });
    },
    [store]
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      store.setModel(modelId);
    },
    [store]
  );

  const handleModeChange = useCallback(
    (modeId: string) => {
      store.setMode(modeId);
    },
    [store]
  );

  const handleCollaborationModeChange = useCallback(
    (modeId: string) => {
      store.setCollaborationMode(modeId);
    },
    [store]
  );

  const handleEffortChange = useCallback(
    (effortId: string) => {
      store.setEffort(effortId);
    },
    [store]
  );

  const handleAttach = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const addFileMentions = useCallback(
    async (files: File[]) => {
      setUploadsPending((count) => count + 1);
      try {
        const regularFiles = files.filter((file) => !shouldUseAcpImageAttachment(file));
        const refs = await Promise.all(
          regularFiles.map(async (file) => {
            try {
              return await uploadDroppedFile(store, file);
            } catch (error) {
              toast.error('Dosya eklenemedi', {
                description: error instanceof Error ? error.message : file.name,
              });
              return null;
            }
          })
        );
        store.addDraftAttachments(
          refs
            .filter((ref): ref is AttachmentRef => ref !== null)
            .map((ref) => ({
              ref: { type: 'attachment', id: ref.id, name: ref.name, mimeType: ref.mimeType },
            }))
        );
      } finally {
        setUploadsPending((count) => count - 1);
      }
    },
    [store]
  );

  const addImageFiles = useCallback(
    async (files: File[]) => {
      setUploadsPending((count) => count + 1);
      try {
        const supportedFiles = files.filter((file) => toAcpImageAttachmentMimeType(file) !== null);
        if (supportedFiles.length < files.length) {
          const unsupportedNames = files
            .filter((file) => toAcpImageAttachmentMimeType(file) === null)
            .map((file) => file.name || 'unnamed image')
            .join(', ');
          toast.error('Unsupported image format', {
            description: `${unsupportedNames} could not be attached. Use PNG, JPEG, GIF, or WebP.`,
          });
        }

        const next = await Promise.all(supportedFiles.map((file) => uploadImageFile(store, file)));
        const uploaded = next.filter((att): att is AcpPromptAttachment => att !== null);
        if (uploaded.length > 0) {
          store.addDraftAttachments(uploaded);
        }
      } finally {
        setUploadsPending((count) => count - 1);
      }
    },
    [store]
  );

  useEffect(() => {
    return registerActiveChatDraftHandler(store.conversationId, async (payload) => {
      if (payload.text?.trim()) {
        const current = store.draftText;
        const snippet = payload.text.trim();
        store.setDraftText(current ? `${current.replace(/\s*$/, '')}\n\n${snippet}` : snippet);
      }
      if (payload.image) {
        const bytes = base64ToUint8Array(payload.image.base64);
        const file = new File([bytes], payload.image.name, { type: payload.image.mimeType });
        await addImageFiles([file]);
      }
      editorApiRef.current?.focus();
    });
  }, [store, addImageFiles]);

  const handleFilesDropped = useCallback(
    async (files: File[]) => {
      const imagesMissingBrowserMime = files.filter(
        (file) => !file.type.toLowerCase().startsWith('image/') && shouldUseAcpImageAttachment(file)
      );
      await Promise.all([addImageFiles(imagesMissingBrowserMime), addFileMentions(files)]);
    },
    [addFileMentions, addImageFiles]
  );

  const handleAttachmentsChange = useCallback(
    (next: ComposerAttachment[]) => {
      const nextIds = new Set(next.map((attachment) => attachment.id));
      for (const attachment of attachments) {
        if (!nextIds.has(attachment.id)) {
          store.removeDraftAttachment(attachment.id);
        }
      }
    },
    [attachments, store]
  );

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      if (files.length === 0) return;

      const images = files.filter(shouldUseAcpImageAttachment);
      await Promise.all([addImageFiles(images), addFileMentions(files)]);
    },
    [addFileMentions, addImageFiles]
  );

  const workspaceId = useObserver(
    () => asProvisioned(getTaskStore(store.projectId, store.taskId))?.workspaceId
  );
  const linkedIssue = useObserver(
    () => getRegisteredTaskData(store.projectId, store.taskId)?.linkedIssue
  );
  const issueProviderContext = useObserver(() => {
    const project = projectData(getProjectStore(store.projectId));
    return {
      projectId: store.projectId,
      projectPath: project?.path,
      repositoryUrl:
        getGitRepositoryStore(store.projectId)?.issueRepositoryUrl ??
        getGitRepositoryStore(store.projectId)?.canonicalRepositoryUrl ??
        undefined,
      selectedIssueProvider: getProjectViewStore(store.projectId)?.selectedIssueProvider ?? null,
    };
  });
  const { connectedProviders, isProviderUsable } = useConnectedIssueProviders(issueProviderContext);
  const issueProvider = useMemo(() => {
    const selected = issueProviderContext.selectedIssueProvider;
    if (selected && isProviderUsable(selected)) return selected;
    return connectedProviders[0] ?? null;
  }, [connectedProviders, isProviderUsable, issueProviderContext.selectedIssueProvider]);

  const mentionProvider = useMemo<ContextMentionProvider | undefined>(() => {
    if (!workspaceId && !linkedIssue && !issueProvider) return undefined;
    const wsId = workspaceId;
    return {
      async search(query: string): Promise<MentionItem[]> {
        const pinnedIssue =
          linkedIssue && issueMatchesQuery(linkedIssue, query)
            ? toIssueMentionItem(linkedIssue)
            : null;
        const issueSearch =
          issueProvider && query.trim().length >= ISSUE_SEARCH_MIN_LENGTH
            ? getIssuesClient()
                .then((client) =>
                  client.searchIssues({
                    provider: issueProvider,
                    options: {
                      limit: ISSUE_SEARCH_LIMIT,
                      searchTerm: query.trim(),
                      projectId: store.projectId,
                      projectPath: issueProviderContext.projectPath,
                      repositoryUrl: issueProviderContext.repositoryUrl ?? undefined,
                    },
                  })
                )
                .catch((error: unknown) => {
                  log.warn('Failed to search issue mentions', { provider: issueProvider, error });
                  return null;
                })
            : Promise.resolve(null);

        const [files, issueResult] = await Promise.all([
          wsId
            ? getSearchClient().then((client) =>
                client.searchWorkspaceFiles({ workspaceId: wsId, query })
              )
            : Promise.resolve([]),
          issueSearch,
        ]);

        const pinnedIssueItems: MentionItem[] = [];
        const searchedIssueItems: MentionItem[] = [];
        const seenIssueIds = new Set<string>();
        if (pinnedIssue) {
          pinnedIssueItems.push(pinnedIssue);
          seenIssueIds.add(pinnedIssue.id);
        }
        if (issueResult?.success) {
          for (const issue of issueResult.data) {
            const item = toIssueMentionItem(issue);
            if (seenIssueIds.has(item.id)) continue;
            seenIssueIds.add(item.id);
            searchedIssueItems.push(item);
          }
        } else if (issueResult && !issueResult.success) {
          log.warn('Failed to search issue mentions', {
            provider: issueProvider,
            error: issueResult.error,
          });
        }

        const fileItems: MentionItem[] = files.map((file) => ({
          id: file.relativePath,
          label: file.relativePath,
          name: file.filename,
          kind: 'file',
          description: file.relativePath,
        }));

        return [...pinnedIssueItems, ...fileItems, ...searchedIssueItems];
      },
    };
  }, [
    workspaceId,
    linkedIssue,
    issueProvider,
    store.projectId,
    issueProviderContext.projectPath,
    issueProviderContext.repositoryUrl,
  ]);

  // Display-only (the selector is locked): static registry metadata, no host needed.
  const { data: agents } = useAgentMetadata();
  const agentOptions = useMemo<ComposerAgentOption[]>(
    () =>
      (agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        icon: <AgentIcon id={a.id} size={14} className="rounded-sm" />,
      })),
    [agents]
  );

  const providerId =
    conversationRegistry.get(store.taskId)?.conversations.get(store.conversationId)?.data
      .providerId ?? null;

  // Sağlayıcı kataloğu (T3 tarzı 3 sütunlu birleşik seçici ve aynı sohbette geçiş).
  const connectionId = getProjectSshConnectionId(store.projectId);
  const host = useMemo(() => hostRefFromConnectionId(connectionId), [connectionId]);
  const { data: fullAgents } = useAgents(host);
  const { data: installStatuses } = useAgentInstallationStatuses(host);
  const hasAnyHistory = !store.isEmpty || store.prefixTurnCount > 0;
  const handoffActive = hasAnyHistory && providerId !== null;
  const handoff = useHandoffAgents(connectionId, providerId, handoffActive);
  const handoffAvailable = handoffActive && handoff.candidates.length > 0;

  const providerCatalog = useMemo<ComposerProviderCatalogEntry[] | null>(() => {
    if (!fullAgents || fullAgents.length === 0) return null;
    const availableSet = new Set(
      (installStatuses ?? [])
        .filter((status) => status.status === 'available')
        .map((status) => status.id)
    );
    const items: ComposerProviderCatalogEntry[] = [];
    for (const agent of fullAgents) {
      if (!agentSupportsAcp(agent.capabilities)) continue;
      if (agent.id !== providerId && !availableSet.has(agent.id)) continue;
      const staticModels =
        agent.capabilities.models.kind === 'selectable' ? agent.capabilities.models.modelOptions : {};
      const localizedStaticModels: Record<string, ComposerModelOption> = Object.fromEntries(
        Object.entries(staticModels).map(([id, opt]) => [
          id,
          {
            name: localizeAgentLabel(opt.name),
            description: localizeAgentLabel(opt.description),
            ...(opt.modelFeatures ? { modelFeatures: opt.modelFeatures } : {}),
          },
        ])
      );
      const isCurrent = agent.id === providerId;
      const models =
        isCurrent && store.modelOptions && Object.keys(store.modelOptions).length > 0
          ? store.modelOptions
          : localizedStaticModels;
      if (Object.keys(models).length === 0) continue;
      const efforts =
        isCurrent && store.effortOptions && Object.keys(store.effortOptions).length > 0
          ? store.effortOptions
          : staticEffortsForProvider(agent.id);
      const badge = agentUsageBadge(handoff.capacities[agent.id], handoff.now);
      items.push({
        id: agent.id,
        name: agent.name,
        icon: <AgentIcon id={agent.id} size={15} className="rounded-sm" />,
        models,
        efforts,
        ...(badge ? { badge } : {}),
      });
    }
    return items.length > 0 ? items : null;
  }, [
    fullAgents,
    installStatuses,
    providerId,
    store.modelOptions,
    store.effortOptions,
    handoff.capacities,
    handoff.now,
  ]);

  const handleProviderModelChange = useCallback(
    (targetProviderId: string, targetModelId: string, targetEffortId?: string) => {
      if (!providerId || targetProviderId === providerId) {
        if (!store.liveActionsEnabled) return;
        if (targetEffortId) {
          store.setModelAndEffort(targetModelId, targetEffortId);
        } else {
          store.setModel(targetModelId);
        }
        return;
      }
      if (disabledReason) return;
      const currentAgentEntry = providerCatalog?.find((p) => p.id === providerId);
      const targetAgentEntry = providerCatalog?.find((p) => p.id === targetProviderId);
      const rawSourceName =
        (store.model ? store.modelOptions?.[store.model]?.name : undefined) ??
        (store.model ? currentAgentEntry?.models[store.model]?.name : undefined) ??
        store.model ??
        currentAgentEntry?.name ??
        providerId;
      const rawTargetName =
        targetAgentEntry?.models[targetModelId]?.name ?? targetModelId;
      void switchConversationProviderInPlace({
        projectId: store.projectId,
        taskId: store.taskId,
        sourceConversationId: store.conversationId,
        sourceProviderId: providerId as AgentProviderId,
        sourceModelLabel: cleanDividerModelLabel(providerId, rawSourceName),
        sourceProviderLabel: currentAgentEntry?.name,
        targetProviderId: targetProviderId as AgentProviderId,
        targetModel: targetModelId,
        targetModelLabel: cleanDividerModelLabel(targetProviderId, rawTargetName),
        ...(targetEffortId ? { targetEffort: targetEffortId } : {}),
        isEmpty: store.isEmpty,
        hasPrefixTurns: store.prefixTurnCount > 0,
        isWorking: store.affordances.isWorking,
        draftText: store.draftText,
        visibleTurns: () => store.visibleTurns(),
      });
    },
    [providerId, store, disabledReason, providerCatalog]
  );

  const providerSwitchHint = useCallback(
    (browsedProviderId: string): string | null => {
      if (!providerId || !browsedProviderId || browsedProviderId === providerId) return null;
      return !store.isEmpty || store.prefixTurnCount > 0
        ? 'Aynı sohbette bağlam aktarımı ile geçilir'
        : 'Sohbet bu yapay zeka ile başlar';
    },
    [providerId, store.isEmpty, store.prefixTurnCount]
  );
  const handoffSource = useMemo(
    () => ({
      conversationId: store.conversationId,
      projectId: store.projectId,
      taskId: store.taskId,
      visibleTurns: () => store.visibleTurns(),
      isWorking: () => store.affordances.isWorking,
    }),
    [store]
  );
  const handoffAgentOptions = useMemo<ComposerAgentOption[]>(() => {
    if (!handoffAvailable) return agentOptions;
    const current = agentOptions.find((option) => option.id === providerId);
    const others = sortHandoffCandidates(handoff.candidates, handoff.capacities).map(
      (candidate): ComposerAgentOption => {
        const base = agentOptions.find((option) => option.id === candidate.id);
        const badge = agentUsageBadge(handoff.capacities[candidate.id], handoff.now);
        return {
          id: candidate.id,
          name: candidate.name,
          icon: base?.icon ?? <AgentIcon id={candidate.id} size={14} className="rounded-sm" />,
          ...(badge ? { badge } : {}),
        };
      }
    );
    return [...(current ? [current] : []), ...others];
  }, [
    handoffAvailable,
    agentOptions,
    providerId,
    handoff.candidates,
    handoff.capacities,
    handoff.now,
  ]);
  const handleHandoffAgentChange = useCallback(
    (agentId: string) =>
      void openHandoffDialog(handoffSource, { targetProviderId: agentId as AgentProviderId }),
    [handoffSource]
  );

  // Limit şeridi: yalnızca önerir; geçişi kullanıcı tıklar. Kapatma kaydı yerel depolamada.
  const limitDismissals = useSyncExternalStore(
    (listener) => getLimitDismissalStore().subscribe(listener),
    () => getLimitDismissalStore().get(store.conversationId)
  );
  const limitBanner = handoffAvailable
    ? decideLimitBanner({
        providerId: providerId ?? '',
        capacity: providerId ? handoff.capacities[providerId] : undefined,
        limitErrorTurnId: store.lastLimitErrorTurnId,
        dismissals: limitDismissals,
        now: handoff.now,
      })
    : ({ show: false } as const);
  const limitSuggestions = useMemo(
    () => suggestHandoffAgents(handoff.candidates, handoff.capacities),
    [handoff.candidates, handoff.capacities]
  );
  const renderMentionIcon = useCallback(({ id, kind }: { id: string; kind: string }) => {
    if (kind !== 'issue') return null;
    const target = parseIssueMentionToken(id);
    if (!target) return null;
    return <IntegrationIcon provider={target.provider} size={12} />;
  }, []);

  const querySlashItems = useCallback(
    async (query: string): Promise<CommandItem[]> => {
      const normalized = query.trim().toLowerCase();
      const commands = store.commands
        .filter((command) => commandMatchesQuery(command, normalized))
        .map((command) => ({
          ...command,
          section: SLASH_COMMANDS_SECTION,
        }));
      const prompts = promptLibrary
        .filter((prompt) => {
          if (!normalized) return true;
          return [prompt.title, prompt.prompt].some((value) =>
            value.toLowerCase().includes(normalized)
          );
        })
        .map((prompt) => ({
          id: `prompt:${prompt.id}`,
          name: prompt.title,
          label: prompt.title,
          description: promptPreview(prompt.prompt),
          behavior: 'insert-text' as const,
          insertText: prompt.prompt,
          section: SLASH_PROMPTS_SECTION,
        }));
      return [...commands, ...prompts];
    },
    [store, promptLibrary]
  );

  const a = store.affordances;
  const permissionRequest = toComposerPermission(store.permissionQueue[0]);

  return createPortal(
    <>
      <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileInputChange} />
      {!disabledReason && store.loadError && (
        <div className="border-destructive/30 bg-destructive/5 mx-3 mb-1 flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs">
          <span className="truncate text-foreground-muted">{store.loadError.message}</span>
          <Button variant="secondary" size="sm" onClick={() => store.retry()}>
            Retry
          </Button>
        </div>
      )}
      <div>
        {uploadsPending > 0 && (
          <div role="status" className="px-4 py-1 text-xs">
            Dosyalar yükleniyor…
          </div>
        )}
        {limitBanner.show && (
          <HandoffLimitBanner
            agentLabel={agentOptions.find((option) => option.id === providerId)?.name ?? 'Ajanın'}
            reason={limitBanner.reason}
            resetsAt={limitBanner.resetsAt}
            now={handoff.now}
            suggestions={limitSuggestions}
            onPick={handleHandoffAgentChange}
            onMore={() =>
              void openHandoffDialog(handoffSource, {
                targetProviderId: sortHandoffCandidates(handoff.candidates, handoff.capacities)[0]
                  ?.id as AgentProviderId | undefined,
              })
            }
            onDismiss={() => {
              const at = Date.now();
              getLimitDismissalStore().add(
                store.conversationId,
                dismissalsFor(limitBanner.signals, at),
                at
              );
            }}
          />
        )}
        <ContextCompactionBanner store={store} onCompact={() => handleSubmit('/compact')} />
        <PromptSuggestionsBar
          store={store}
          projectName={issueProviderContext.projectPath?.split(/[/\\]/).pop()}
          taskName={linkedIssue?.title}
          onPickSuggestion={(text) => {
            store.setDraftText(text);
            editorApiRef.current?.focus();
          }}
        />
        <ChatComposer
          model={store.composerModel}
          isWorking={a.isWorking}
          canSubmit={a.canSubmit && uploadsPending === 0}
          onSubmit={handleSubmit}
          onSubmitWhileWorking={
            store.liveActionsEnabled && uploadsPending === 0 ? handleSubmitWhileWorking : undefined
          }
          onStop={a.canCancel ? handleStop : undefined}
          permissionRequest={permissionRequest}
          permissionQueueCount={store.permissionQueue.length}
          onResolvePermission={handleResolvePermission}
          queuedPrompts={store.queuedPrompts}
          onEditQueuedPrompt={(id, text) => store.editQueuedPrompt(id, text)}
          onDeleteQueuedPrompt={(id) => store.deleteQueuedPrompt(id)}
          onReorderQueuedPrompts={(ids) => store.reorderQueuedPrompts(ids)}
          onSendQueuedPromptNow={handleSendQueuedPromptNow}
          editorApiRef={editorApiRef}
          modelOptions={store.modelOptions}
          selectedModel={store.model ?? undefined}
          onModelChange={store.liveActionsEnabled ? handleModelChange : undefined}
          effortOptions={store.effortOptions}
          selectedEffort={store.effort ?? undefined}
          onEffortChange={store.liveActionsEnabled ? handleEffortChange : undefined}
          onModelAndEffortChange={
            store.liveActionsEnabled
              ? (modelId, effortId) => store.setModelAndEffort(modelId, effortId)
              : undefined
          }
          permissionModeOptions={store.permissionModeOptions}
          selectedPermissionMode={store.permissionMode ?? undefined}
          onPermissionModeChange={store.liveActionsEnabled ? handleModeChange : undefined}
          collaborationModeOptions={store.collaborationModeOptions}
          selectedCollaborationMode={store.collaborationMode ?? undefined}
          onCollaborationModeChange={
            store.liveActionsEnabled ? handleCollaborationModeChange : undefined
          }
          mcpServers={store.mcpServers}
          agentOptions={handoffAvailable ? handoffAgentOptions : agentOptions}
          selectedAgent={providerId ?? undefined}
          agentLocked
          agentSwitchMode={handoffAvailable ? 'handoff' : 'locked'}
          onAgentChange={handleHandoffAgentChange}
          providerCatalog={providerCatalog}
          onProviderModelChange={!disabledReason ? handleProviderModelChange : undefined}
          providerSwitchHint={providerSwitchHint}
          contextUsage={
            store.usage
              ? {
                  used: store.usage.contextUsed,
                  size: store.usage.contextSize,
                  cost: store.usage.cost,
                }
              : null
          }
          mentionProvider={mentionProvider}
          renderMentionIcon={renderMentionIcon}
          queryCommands={querySlashItems}
          attachments={attachments}
          onAttachmentsChange={handleAttachmentsChange}
          onAttach={store.liveActionsEnabled ? handleAttach : undefined}
          toolbarAccessory={
            <DictationButton
              editorApiRef={editorApiRef}
              shortcutScope={composerSlot}
              disabled={Boolean(disabledReason)}
              onSubmitAfterDictation={handleSubmit}
            />
          }
          onImageFilesDropped={
            store.liveActionsEnabled ? (files) => void addImageFiles(files) : undefined
          }
          onFilesDropped={
            store.liveActionsEnabled ? (files) => void handleFilesDropped(files) : undefined
          }
          onViewImage={(att) => onViewerOpen(att.previewUrl, att.name)}
        />
      </div>
    </>,
    composerSlot
  );
});

// ── AcpChatPanel ──────────────────────────────────────────────────────────────
//
// One persistent ChatTranscript is mounted for the lifetime of this panel.
// When the active conversation changes, props.state identity changes, which
// triggers ChatTranscript's setModel effect — the Solid view swaps ChatState
// in-place without dispose/recreate, preserving per-conversation scroll.
//
// The composer subtree is keyed by conversationId; each store retains its own
// editor model while only the active conversation has a mounted editor view.

export const AcpChatPanel = observer(function AcpChatPanel() {
  const { pane } = usePaneContext();

  const activeTab = pane.resolvedTabs.find((t) => t.isActive && t.kind === 'acp-chat');
  const store = activeTab ? (activeTab.resource as AcpChatTabResource).store : null;

  const rootRef = useRef<HTMLDivElement | null>(null);

  // Sohbet metninde sag tik menusu: kopyala / baglam olarak ekle / alintila.
  const handleAddToDraft = useCallback(
    (text: string) => {
      if (!store) return;
      const current = store.draftText;
      store.setDraftText(current ? `${current.replace(/\s*$/, '')}\n${text}` : text);
    },
    [store]
  );
  const selectionMenu = useSelectionContextMenu({ onAddToDraft: handleAddToDraft });
  const viewRef = useRef<ChatView | null>(null);
  const [composerSlot, setComposerSlot] = useState<HTMLElement | null>(null);
  const [heroSlot, setHeroSlot] = useState<HTMLElement | null>(null);
  const [overlaySlot, setOverlaySlot] = useState<HTMLElement | null>(null);
  const continueSubmitRef = useRef<((text: string) => void) | null>(null);
  const registerContinueSubmit = useCallback((submit: ((text: string) => void) | null) => {
    continueSubmitRef.current = submit;
  }, []);
  const [viewer, setViewer] = useState<{ src?: string; alt?: string } | null>(null);
  const [mermaidViewer, setMermaidViewer] = useState<{ svg: string | null } | null>(null);
  const placementConversationRef = useRef<string | null>(null);
  const placementWasEmptyRef = useRef<boolean | null>(null);
  // True while the scroll viewport is at the tail. Defaults to true so the
  // button does not flash on mount before the first frame fires.
  const [atBottom, setAtBottom] = useState(true);
  // Sub-agent side panel (diagram or feed); closes when the conversation changes.
  const [subagentPanel, setSubagentPanel] = useState<{
    view: SubagentPanelView;
    target: SubagentTarget | null;
  } | null>(null);
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const orchestraLinks = useOrchestraWorkerLinks(store);
  const runningNativeSubagents = useRunningNativeSubagents(store);
  const runningSubagents = useMemo(
    () => [...runningNativeSubagents, ...orchestraLinks.running],
    [runningNativeSubagents, orchestraLinks.running]
  );

  const handleReady = useCallback((view: ChatView) => {
    viewRef.current = view;
    setComposerSlot(view.composerSlot);
    setHeroSlot(view.heroSlot);
    setOverlaySlot(view.contentOverlay);
  }, []);

  const isConversationEmpty = useObserver(() =>
    store ? store.isEmpty && store.prefixTurnCount === 0 : false
  );
  const activeConversationId = store?.conversationId ?? null;

  useEffect(() => {
    setFocusedChatConversation(activeConversationId);
  }, [activeConversationId]);

  useEffect(() => {
    setSubagentPanel(null);
  }, [activeConversationId]);

  useEffect(() => {
    if (!store || !viewRef.current) return;
    const sameConversation = placementConversationRef.current === store.conversationId;
    const wasEmpty = placementWasEmptyRef.current === true;
    const placement = isConversationEmpty ? 'center' : 'bottom';
    viewRef.current.setComposerPlacement(placement, {
      animate: sameConversation && wasEmpty && !isConversationEmpty,
    });
    placementConversationRef.current = store.conversationId;
    placementWasEmptyRef.current = isConversationEmpty;
  }, [store, activeConversationId, isConversationEmpty, composerSlot]);

  // Bind/unbind the view handle to the active store so the store can call
  // scrollToItem on submit. Only the active store holds the handle.
  useEffect(() => {
    if (!store) return;
    store.bindView(viewRef.current);
    return () => {
      store.bindView(null);
    };
  }, [store]);

  // State-driven notification clearing: mark the active conversation as seen
  // immediately when the panel is showing it. This covers the split-pane case
  // where the same tab stays active and onActivate() does not re-fire.
  const conversationStore = useObserver(() =>
    store
      ? conversationRegistry.get(store.taskId)?.conversations.get(store.conversationId)
      : undefined
  );
  const conversationSeen = conversationStore?.seen;
  const connectionId = useObserver(() =>
    store ? getProjectSshConnectionId(store.projectId) : undefined
  );
  const host = useMemo(() => hostRefFromConnectionId(connectionId), [connectionId]);
  const { data: agents } = useAgents(host);
  const providerId = conversationStore?.data.providerId ?? null;
  const agent = agents?.find((candidate) => candidate.id === providerId) ?? null;
  const cliAuthMethod =
    agent?.capabilities.auth.kind === 'supported'
      ? agent.capabilities.auth.methods.find((method) => method.kind === 'cli-login')
      : undefined;

  const openSignInModal = useCallback(() => {
    if (!providerId || !cliAuthMethod || !store) return;
    void openModal('agentSignInModal', {
      providerId,
      methodId: cliAuthMethod.id,
      providerName: agent?.name ?? providerId,
      host,
    }).then((outcome) => {
      if (outcome.success) {
        if (store.loadError?.kind === 'auth_required') store.retry();
      }
    });
  }, [agent?.name, cliAuthMethod, host, providerId, store]);

  useEffect(() => {
    if (conversationStore && !conversationStore.seen) {
      conversationStore.markSeen();
    }
  }, [conversationStore, conversationSeen]);

  useEffect(() => {
    if (!store) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !eventComposedPathContains(event, root)) return;

      const commandId = chatViewCommandForShortcut(event);
      if (!commandId) return;
      if (!executeChatViewCommand(viewRef.current, commandId)) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [store]);

  const handleViewerOpen = useCallback((src?: string, alt?: string) => {
    setViewer({ src, alt });
  }, []);

  const transcriptCommands = useMemo<ChatCommands>(() => {
    const fileCommands = store
      ? createTranscriptFileCommands({ projectId: store.projectId, taskId: store.taskId })
      : null;
    const subagentCommands: Pick<ChatCommands, 'onOpenSubagent' | 'resolveSubagentPhase'> = {
      onOpenSubagent: (arg) => setSubagentPanel({ view: 'feed', target: arg }),
      resolveSubagentPhase: (arg) =>
        arg.source === 'orchestra-worker' ? orchestraLinks.phaseFor(arg.toolCallId) : undefined,
    };
    return {
      ...subagentCommands,
      onForkFromMessage: store
        ? (arg) =>
            void forkConversation(
              {
                conversationId: store.conversationId,
                projectId: store.projectId,
                taskId: store.taskId,
                visibleTurns: () => store.visibleTurns(),
                isWorking: () => store.affordances.isWorking,
              },
              { upToItemId: arg.itemId }
            )
        : undefined,
      resolveArtifact: store
        ? createTranscriptArtifactResolver({ projectId: store.projectId, taskId: store.taskId })
        : undefined,
      artifactExists: store
        ? createTranscriptArtifactExists({ projectId: store.projectId, taskId: store.taskId })
        : undefined,
      onShareArtifact: store
        ? (artifact) =>
            void openModal('shareArtifactModal', {
              projectId: store.projectId,
              taskId: store.taskId,
              artifact,
            })
        : undefined,
      onViewImage: (arg) => {
        if (arg.attachment.dataUrl || !store) {
          handleViewerOpen(arg.attachment.dataUrl, arg.attachment.name);
          return;
        }
        void resolveAttachmentDataUrl(store, arg.attachment.id).then((src) =>
          handleViewerOpen(src ?? undefined, arg.attachment.name)
        );
      },
      resolveAttachment: (attachment) =>
        store ? resolveAttachmentDataUrl(store, attachment.id) : Promise.resolve(null),
      onViewMermaid: (arg) => {
        setMermaidViewer({
          svg: store?.chatContext.sharedCaches.renderMermaid(arg.chart) ?? null,
        });
      },
      onRewind: ({ promptId }) => {
        if (!store) return;
        if (store.affordances.isWorking) {
          toast.error('Ajan çalışırken geri sarılamaz', {
            description: 'Önce mevcut turu durdurun, sonra tekrar deneyin.',
          });
          return;
        }
        void openModal('rewindCheckpointModal', {
          conversationId: store.conversationId,
          promptId,
        });
      },
      classifyLink: fileCommands?.classifyLink,
      onOpenFile: fileCommands?.onOpenFile,
      onClickMention: (arg: Parameters<NonNullable<ChatCommands['onClickMention']>>[0]) => {
        if (!store) return;
        if (arg.kind === 'file') {
          fileCommands?.openMentionFile(arg.id);
          return;
        }
        if (arg.kind === 'issue') {
          const target = parseIssueMentionToken(arg.id);
          if (!target) return;
          const source = resolveIssueMentionSource(
            target,
            getRegisteredTaskData(store.projectId, store.taskId)?.linkedIssue
          );
          if (!source) return;
          void getIssuesClient()
            .then((client) =>
              client.getIssueContext({
                provider: target.provider,
                options: {
                  identifier: source.identifier,
                  accountId: source.accountId,
                  issueUrl: source.issueUrl,
                  projectId: store.projectId,
                },
              })
            )
            .then((result) => {
              if (result.success && result.data.url) {
                void openExternal(result.data.url);
              }
            });
        }
      },
    };
    // orchestraLinks.key refreshes sub-agent rows when worker phases change.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [store, handleViewerOpen, orchestraLinks.key]);

  const [liveSubagentsOpen, setLiveSubagentsOpen] = useState(true);
  const liveSubagents = store ? store.agents : [];
  const prevLiveSubagentCountRef = useRef(0);

  useEffect(() => {
    if (liveSubagents.length > prevLiveSubagentCountRef.current) {
      setLiveSubagentsOpen(true);
    }
    prevLiveSubagentCountRef.current = liveSubagents.length;
  }, [liveSubagents.length]);

  if (!store) return null;

  const showLiveSubagentsPanel = !subagentPanel && liveSubagents.length > 0 && liveSubagentsOpen;
  const showLiveSubagentsToggle = !subagentPanel && liveSubagents.length > 0 && !liveSubagentsOpen;

  const hasVisualHistory = store.messageCount > 0 || store.prefixTurnCount > 0;
  const unavailableWithoutTranscript =
    store.loadError?.kind === 'unavailable' && !hasVisualHistory;
  const showComposer =
    store.loadError?.kind !== 'auth_required' && (store.historyKnown || hasVisualHistory);
  const showBlockingOverlay =
    !showComposer &&
    (store.historyLoading ||
      (store.loadError !== null && store.loadError.kind !== 'unavailable') ||
      unavailableWithoutTranscript);
  const showHero = showComposer && !hasVisualHistory && store.isEmpty && store.loadError === null;

  return (
    <div
      ref={rootRef}
      onContextMenu={selectionMenu.onContextMenu}
      className="surface-paper relative flex h-full overflow-hidden bg-(--em-surface)"
    >
      <div className="relative h-full min-w-0 flex-1">
        <ChatTranscript
          context={store.chatContext}
          state={store.chatState}
          composer="slot"
          composerPlacement={hasVisualHistory || !store.isEmpty ? 'bottom' : 'center'}
          contentOverlay
          stickToBottom
          pinUserMessages
          onReady={handleReady}
          commands={transcriptCommands}
          onAtBottomChange={setAtBottom}
          style={{ position: 'absolute', inset: 0 }}
        />
        {(showComposer || showLiveSubagentsToggle) && (
          <div className="pointer-events-none absolute top-2 right-3 z-10 flex items-center gap-2">
            {showLiveSubagentsToggle && (
              <AcpSubagentsTogglePill
                agents={liveSubagents}
                onOpen={() => setLiveSubagentsOpen(true)}
              />
            )}
            {showComposer && (
              <Button
                type="button"
                variant={sideChatOpen ? 'primary' : 'secondary'}
                size="xs"
                onClick={() => setSideChatOpen((v) => !v)}
                className="pointer-events-auto"
                title="Ana sohbetin bağlamını kirletmeden geçici yan sohbet aç"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                Yan Sohbet
              </Button>
            )}
            {showComposer && <SpokenRepliesControl source={store} />}
          </div>
        )}
      </div>

      {selectionMenu.element}

      {/* Authentication errors own the content area so sign-in remains accessible even after
          attachment. Otherwise, show the composer as soon as history is known. */}
      {overlaySlot &&
        showBlockingOverlay &&
        createPortal(
          <div
            // The library-owned overlay slot is pointer-events: none by design;
            // opt back in so the Sign in / Retry buttons are clickable.
            className={`pointer-events-auto absolute inset-0 flex items-center justify-center text-sm text-foreground-muted ${
              showBlockingOverlay ? 'bg-(--em-surface)' : ''
            }`}
            aria-live="polite"
          >
            {store.loadError?.kind === 'unavailable' ? (
              <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center">
                <span className="text-foreground">Chat unavailable</span>
                <span className="text-xs text-foreground-muted">{store.loadError.message}</span>
              </div>
            ) : store.loadError !== null ? (
              store.loadError.kind === 'auth_required' ? (
                <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center">
                  <span className="text-foreground">
                    {agent?.name ?? 'This agent'} needs you to sign in.
                  </span>
                  <span className="text-xs text-foreground-muted">
                    {cliAuthMethod?.description ?? store.loadError.message}
                  </span>
                  <div className="mt-1 flex gap-2">
                    {cliAuthMethod && (
                      <Button variant="primary" size="sm" onClick={openSignInModal}>
                        Sign in
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => store.retry()}>
                      Retry
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center">
                  <span className="text-foreground">Failed to load chat.</span>
                  <span className="text-xs text-foreground-muted">{store.loadError.message}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-1"
                    onClick={() => store.retry()}
                  >
                    Retry
                  </Button>
                </div>
              )
            ) : (
              'Loading chat...'
            )}
          </div>,
          overlaySlot
        )}

      {showHero &&
        heroSlot &&
        createPortal(
          <div className="px-4 text-center">
            <h1 className="text-2xl tracking-tight text-foreground">What are we building today?</h1>
            <HandoffNotice
              conversationId={store.conversationId}
              onContinue={createContinueHandler((text) => continueSubmitRef.current?.(text))}
              continueDisabled={!store.affordances.canSubmit}
            />
          </div>,
          heroSlot
        )}

      {showComposer && composerSlot && (
        <ComposerForStore
          key={store.conversationId}
          store={store}
          composerSlot={composerSlot}
          onViewerOpen={handleViewerOpen}
          onRegisterSubmit={registerContinueSubmit}
        />
      )}

      {showComposer &&
        composerSlot &&
        runningSubagents.length > 0 &&
        createPortal(
          <div className="pointer-events-none absolute bottom-full left-3 mb-2 flex max-w-[60%]">
            <SubagentRunningChip
              running={runningSubagents}
              onOpen={() =>
                setSubagentPanel((current) => ({
                  view: 'diagram',
                  target: current?.target ?? null,
                }))
              }
            />
          </div>,
          composerSlot
        )}

      {showComposer &&
        composerSlot &&
        createPortal(
          <div className="pointer-events-none absolute right-3 bottom-full mb-2 flex max-w-[60%] flex-col items-end">
            <ComputerUseChip conversationId={store.conversationId} remote={!!connectionId} />
          </div>,
          composerSlot
        )}

      {showComposer &&
        composerSlot &&
        !atBottom &&
        createPortal(
          <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex justify-center">
            <Button
              variant="secondary"
              icon
              aria-label="Scroll to bottom"
              onClick={() => viewRef.current?.scrollToBottom({ behavior: 'smooth' })}
              className="pointer-events-auto rounded-full shadow-md"
            >
              <ArrowDown />
            </Button>
          </div>,
          composerSlot
        )}

      {subagentPanel ? (
        <SubagentSidePanel
          view={subagentPanel.view}
          target={subagentPanel.target}
          store={store}
          links={orchestraLinks}
          rootAgentName={agent?.name}
          onChangeView={(view) =>
            setSubagentPanel((current) => (current ? { ...current, view } : current))
          }
          onSelectTarget={(target) => setSubagentPanel({ view: 'feed', target })}
          onClose={() => setSubagentPanel(null)}
        />
      ) : showLiveSubagentsPanel ? (
        <AcpSubagentsPanel agents={liveSubagents} onClose={() => setLiveSubagentsOpen(false)} />
      ) : null}

      {sideChatOpen && (
        <AcpSideChatDrawer
          store={store}
          onClose={() => setSideChatOpen(false)}
          onTransferToMain={(text) => {
            void injectIntoActiveChatDraft({ text });
            toast.success('Yanıt ana sohbet taslağına aktarıldı');
          }}
        />
      )}

      <ReviewFindingsSidePanel
        projectId={store.projectId}
        taskId={store.taskId}
        conversationId={store.conversationId}
        isWorking={store.affordances.isWorking}
        readTranscript={() => {
          const state = store.chatState.transcript.state;
          return {
            turns: transcriptTurns(state),
            activeTurnId: state.activeTurnSnapshot?.id ?? null,
          };
        }}
      />

      <ImageViewerDialog
        open={!!viewer}
        onOpenChange={(open) => {
          if (!open) setViewer(null);
        }}
        src={viewer?.src}
        alt={viewer?.alt}
      />
      <MermaidViewerDialog
        open={!!mermaidViewer}
        onOpenChange={(open) => {
          if (!open) setMermaidViewer(null);
        }}
        svg={mermaidViewer?.svg ?? null}
      />
    </div>
  );
});

function eventComposedPathContains(event: Event, element: HTMLElement): boolean {
  if (event.composedPath().includes(element)) return true;
  return event.target instanceof Node && element.contains(event.target);
}
