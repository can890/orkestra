import type { PromptPlacement } from '@orkestra/core/runtimes/acp/api/client';
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
  MediaViewerItem,
  MentionItem,
  ModelPickerRightPanelContext,
  PromptEditorRef,
} from '@orkestra/ui/react/components';
import { Button, DropdownMenu, toast } from '@orkestra/ui/react/primitives';
import {
  ArrowDown,
  Copy,
  Download,
  FileJson,
  FileText,
  ImagePlus,
  MessageSquarePlus,
} from 'lucide-react';
import { observer, useObserver } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentInstallationStatuses } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { useAgentSettings } from '@core/features/agents/api/browser/use-agent-settings';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
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
  createTranscriptArtifactMediaUrl,
  createTranscriptArtifactResolver,
  createTranscriptArtifactSaver,
} from '@core/features/conversations/api/browser/chat/transcript-artifact-commands';
import { recordLastUsedAgent } from '@core/features/conversations/api/browser/last-used-agent';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { contextHandoffSystemNotice } from '@core/features/conversations/api/context-handoff-package';
import { conversationComposerScope } from '@core/features/conversations/contributions/scopes';
import { useConnectedIssueProviders } from '@core/features/integrations/api/browser/use-connected-issue-providers';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import { getIssuesClient } from '@core/features/issues/api/browser/client';
import { usePromptLibrary } from '@core/features/library/api/browser/prompts/use-prompt-library';
import {
  createChatMcpAppHost,
  submitMcpAppMessage,
} from '@core/features/mcp-apps/api/browser/chat-mcp-apps';
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
import { ComposerUsageRing } from '@core/features/usage-limits/contributions/browser/composer-usage-ring';
import { DictationButton } from '@core/features/voice/contributions/browser/dictation-button';
import { SpokenRepliesControl } from '@core/features/voice/contributions/browser/spoken-replies-control';
import { openModal } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { agentSupportsAcp } from '@core/primitives/agents/api';
import {
  ANTIGRAVITY_EFFORT_LABELS,
  ANTIGRAVITY_EXECUTOR_FAMILIES,
  ANTIGRAVITY_PLANNER_FAMILIES,
  buildAntigravityRoleSlug,
  normalizeProviderOrchestratorConfig,
  parseAntigravityRoleSlug,
  type AntigravityOrchestratorEffort,
  type AntigravityOrchestratorMode,
  type AntigravityRoleModelFamily,
  type ProviderOrchestratorConfig,
} from '@core/primitives/app-settings/api';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import {
  hasDraggedFiles,
  hasDraggedWorkspaceFile,
} from '@core/primitives/drag-files/browser/drag-files';
import { issueMentionToken, parseIssueMentionToken } from '@core/primitives/issues/api';
import { resolveIssueMentionSource } from '@core/primitives/issues/api/issue-context';
import { linkedIssueMentionName, type LinkedIssue } from '@core/primitives/linked-issues/api';
import { log } from '@core/primitives/logging/browser/logger';
import { disabled, enabled, type ViewScopeImpl } from '@core/primitives/view-scopes/api';
import { useViewScope } from '@core/primitives/view-scopes/react';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import { ContextHandoffBanner } from '../handoff/context-handoff-banner';
import { moveConversationToNewContext } from '../handoff/context-handoff-runtime';
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
import { ComposerStashMenu } from '../prompt-stash/composer-stash-menu';
import { useComposerStash } from '../prompt-stash/use-composer-stash';
import type { AcpChatStore, AcpPromptAttachment } from './acp-chat-store';
import type { AcpChatTabResource } from './acp-chat-tab-resource';
import { chatViewCommandForShortcut, executeChatViewCommand } from './acp-chat-view-commands';
import {
  droppedFileMimeType,
  shouldUseAcpImageAttachment,
  toAcpImageAttachmentMimeType,
  uploadDroppedFile,
} from './acp-dropped-file';
import { AcpSideChatDrawer } from './acp-side-chat-drawer';
import { AcpSubagentsPanel, AcpSubagentsTogglePill } from './acp-subagents-panel';
import { localizeAgentLabel } from './agent-labels-tr';
import { withArtifactOutputContext } from './artifact-output-context';
import { EditMessageChip, ManualCompactButton, ReplyQuoteChip } from './composer-context-chips';
import { workingTurnPlacement } from './composer-submit';
import { ComputerUseChip } from './computer-use-chip';
import { ContextCompactionBanner } from './context-compaction-banner';
import {
  buildTranscriptMarkdownFilename,
  formatTranscriptAsMarkdown,
} from './format-transcript-markdown';
import { buildIssueMentionHiddenContext } from './issue-mention-context';
import { branchConversationFromBeforeItem } from './message-branch-actions';
import { consumePendingScrollToMessage, onScrollToMessageRequest } from './message-scroll-bus';
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

function staticEffortsForProvider(providerId: string): Record<string, ComposerEffortOption> | null {
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
  const name = attachment.ref.name ?? 'attachment';
  const mime = (attachment.ref.mimeType ?? '').toLowerCase();
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  let kind: ComposerAttachment['kind'] = 'file';
  if (
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
  ) {
    kind = 'image';
  } else if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) {
    kind = 'video';
  } else if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
    kind = 'audio';
  }
  return {
    id: attachment.ref.id,
    name,
    kind,
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

const ORCHESTRATOR_PRESET_IDS = new Set<string>([
  'gemini-pro-orchestrator-neon',
  'gemini-pro-orchestrator',
  'gemini-pro-orchestrator-argon',
]);

const AUTO_PERMISSION_MODES = new Set<string>([
  'auto',
  'bypassPermissions',
  'always-approve',
  'full-access',
  'agent-full-access',
  'yolo',
]);

function AntigravityRoleSelectorBlock({
  title,
  families,
  selectedSlug,
  onSelectSlug,
}: {
  title: string;
  families: readonly AntigravityRoleModelFamily[];
  selectedSlug: string | undefined;
  onSelectSlug: (slug: string) => void;
}) {
  const parsed = parseAntigravityRoleSlug(selectedSlug, families);
  const currentFamily = families.find((item) => item.id === parsed?.familyId) ?? families[0]!;
  const currentEffort = parsed?.effort ?? currentFamily.defaultEffort;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground-muted">{title}</span>
        <span className="truncate text-[10.5px] font-medium text-foreground">
          {currentFamily.label.replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, '')} ·{' '}
          {ANTIGRAVITY_EFFORT_LABELS[currentEffort]}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {families.map((family) => {
          const active = family.id === currentFamily.id;
          const nextEffort: AntigravityOrchestratorEffort = family.efforts.includes(currentEffort)
            ? currentEffort
            : family.defaultEffort;
          const shortLabel = family.label
            .replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, '')
            .replace(/^Claude\s+/i, '');
          return (
            <button
              key={family.id}
              type="button"
              onClick={() => {
                const slug = buildAntigravityRoleSlug(family.id, nextEffort, families);
                if (slug) onSelectSlug(slug);
              }}
              className={`cursor-pointer rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                active
                  ? 'border-foreground/30 bg-foreground/[0.12] font-medium text-foreground'
                  : 'border-border/70 bg-transparent text-foreground-muted hover:bg-foreground/[0.06] hover:text-foreground'
              }`}
            >
              {shortLabel}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-[10px] text-foreground-muted/80">Çaba:</span>
        {currentFamily.efforts.map((effort) => {
          const active = effort === currentEffort;
          return (
            <button
              key={effort}
              type="button"
              onClick={() => {
                const slug = buildAntigravityRoleSlug(currentFamily.id, effort, families);
                if (slug) onSelectSlug(slug);
              }}
              className={`cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
                active
                  ? 'bg-emerald-500/20 font-medium text-emerald-400'
                  : 'text-foreground-muted hover:bg-foreground/[0.06] hover:text-foreground'
              }`}
            >
              {ANTIGRAVITY_EFFORT_LABELS[effort]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function findPrecedingUserPromptText(
  turns: readonly { items: readonly unknown[] }[],
  assistantItemId: string
): string | null {
  const messages: Array<{ id: string; role: string; text: string }> = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (
        item &&
        typeof item === 'object' &&
        (item as { kind?: unknown }).kind === 'message' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { role?: unknown }).role === 'string' &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        messages.push({
          id: (item as { id: string }).id,
          role: (item as { role: string }).role,
          text: (item as { text: string }).text,
        });
      }
    }
  }
  const idx = messages.findIndex((msg) => msg.id === assistantItemId);
  const start = idx >= 0 ? idx - 1 : messages.length - 1;
  for (let i = start; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate?.role === 'user' && candidate.text.trim()) {
      return candidate.text;
    }
  }
  return null;
}

function formatReplyQuote(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const nonEmptyLines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const selected: string[] = [];
  let totalChars = 0;
  let truncated = false;
  for (const line of nonEmptyLines) {
    if (selected.length >= 6) {
      truncated = true;
      break;
    }
    const remaining = 450 - totalChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (line.length > remaining) {
      selected.push(`${line.slice(0, Math.max(1, remaining - 1))}…`);
      truncated = true;
      break;
    }
    selected.push(line);
    totalChars += line.length + 1;
  }
  if (truncated && selected.length > 0 && !selected[selected.length - 1]!.endsWith('…')) {
    selected[selected.length - 1] = `${selected[selected.length - 1]}…`;
  }
  return `${selected.map((line) => `> ${line}`).join('\n')}\n\n`;
}

// ── Composer for a single store ────────────────────────────────────────────────
//
// Keyed by conversationId to isolate view-local UI. The store owns the editor
// model so the document, selection, viewport and undo history survive remounts.

/**
 * The saved agent session is definitely gone: after the user confirms, the conversation continues
 * with a new session. Never offered for a transient failure (see `AcpLoadError`).
 */
function confirmContinueWithNewSession(store: AcpChatStore): void {
  void openModal('confirmActionModal', {
    title: 'Yeni oturumla devam edilsin mi?',
    description:
      'Ajan bu sohbetin kayıtlı oturumunu artık bulamıyor. Yeni bir oturum başlatılır: ' +
      'görünen yazışma ekranda kalır, ama ajan önceki turları hatırlamaz.',
    confirmLabel: 'Yeni oturumla devam et',
  }).then((outcome) => {
    if (outcome.success) store.continueWithNewSession();
  });
}

const ComposerForStore = observer(function ComposerForStore({
  store,
  composerSlot,
  onViewerOpen,
  onRegisterSubmit,
  onRegisterEditDraft,
  onRegisterReplyDraft,
  onRegisterDropFiles,
}: {
  store: AcpChatStore;
  composerSlot: HTMLElement;
  onViewerOpen: (items: MediaViewerItem[], initialIndex?: number) => void;
  /** Karşılama alanındaki "Kaldığı yerden devam et" düğmesi için gönderim işleyicisini bildirir. */
  onRegisterSubmit?: (submit: ((text: string) => void) | null) => void;
  /** Eski kullanıcı mesajındaki "Düzenle" eylemi için hedefi ve taslağı bildirip odaklar. */
  onRegisterEditDraft?: (edit: ((target: { itemId: string; text: string }) => void) | null) => void;
  /** Eski asistan yanıtındaki "Yanıtla" eylemi için alıntı çipini açıp odaklar. */
  onRegisterReplyDraft?: (reply: ((quote: string) => void) | null) => void;
  /** Sohbet paneline bırakılan dosyaları aynı ekleme akışına yönlendirmek için işleyiciyi bildirir. */
  onRegisterDropFiles?: (handler: ((files: File[]) => Promise<void>) | null) => void;
}) {
  const editorApiRef = useRef<PromptEditorRef | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadsPending, setUploadsPending] = useState(0);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [editingTarget, setEditingTarget] = useState<{ itemId: string; text: string } | null>(null);
  const { value: chatSettings } = useAppSettingsKey('chat');
  const workingTurnSubmitMode = chatSettings?.workingTurnSubmitMode ?? 'steer-cancel';
  const attachments = store.draftAttachments.map(toComposerAttachment);
  const { value: promptLibrary } = usePromptLibrary();
  const disabledReason = projectAvailabilityUi.getLiveActionDisabledReason(store.projectId);
  const providerId =
    conversationRegistry.get(store.taskId)?.conversations.get(store.conversationId)?.data
      .providerId ?? null;

  useEffect(() => {
    setReplyQuote(null);
    setEditingTarget(null);
  }, [store.conversationId]);

  // Yeni açılan veya yapay zekası değişen sohbetlerde giriş kutusuna odaklan.
  useEffect(() => {
    const raf = requestAnimationFrame(() => editorApiRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [composerSlot, store.conversationId]);

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

  // İstem zulası: Mod+S (Klavye ayarlarından değiştirilebilir) ve araç çubuğu menüsü.
  const stash = useComposerStash(store, {
    uploadsPending,
    disabledReason,
    focusComposer: () => editorApiRef.current?.focus(),
  });
  const composerScopeImpl: ViewScopeImpl<typeof conversationComposerScope> = {
    ...stash.scopeImplementation,
    // "Sohbeti yeni bağlama taşı" (komut paleti): öneri şeridiyle aynı akış.
    'conversations.moveToNewContext': () => ({
      availability: () =>
        disabledReason
          ? disabled(disabledReason)
          : store.messageCount > 0 || store.prefixTurnCount > 0
            ? enabled
            : disabled('Sohbette taşınacak bir şey yok'),
      execute: () => void moveConversationToNewContext(store),
    }),
  };
  const { attachRef: attachComposerScope } = useViewScope(
    conversationComposerScope({ conversationId: store.conversationId }),
    composerScopeImpl
  );

  const handleSubmit = useCallback(
    (value: string, placement?: PromptPlacement) => {
      if (uploadsPending > 0) return;
      const promptAttachments = store.draftAttachments;
      if (!value.trim() && promptAttachments.length === 0) return;

      if (editingTarget) {
        if (store.affordances.isWorking) {
          toast.warning('Önce mevcut yanıtı durdurun.');
          return;
        }
        const finalEditText = value.trim();
        if (!finalEditText) return;
        const target = editingTarget;
        setEditingTarget(null);
        store.setDraftText('');
        if (providerId) {
          recordLastUsedAgent({ providerId, model: store.model, effort: store.effort });
        }
        void branchConversationFromBeforeItem({
          projectId: store.projectId,
          taskId: store.taskId,
          sourceConversationId: store.conversationId,
          targetItemId: target.itemId,
          visibleTurns: store.visibleTurns(),
          autoSendPromptText: finalEditText,
          permissionMode: store.permissionMode,
          effort: store.effort,
        }).catch((error: unknown) => {
          setEditingTarget(target);
          store.setDraftText(finalEditText);
          toast.error('Düzenlenen mesaj için yeni dal açılamadı', {
            description: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }

      const activeQuote = replyQuote;
      const quotePrefix = activeQuote ? formatReplyQuote(activeQuote) : '';
      const finalText = quotePrefix ? `${quotePrefix}${value}` : value;
      if (activeQuote) {
        setReplyQuote(null);
      }

      const isFirstOwnPrompt = store.messageCount === 0;
      const issueContext = buildHiddenIssueContext(finalText);
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
      if (providerId) {
        recordLastUsedAgent({ providerId, model: store.model, effort: store.effort });
      }
      store.submitPrompt(
        finalText,
        promptAttachments,
        withArtifactOutputContext(hiddenContext),
        placement
      );
    },
    [store, providerId, buildHiddenIssueContext, uploadsPending, editingTarget, replyQuote]
  );

  const handleSubmitWhileWorking = useCallback(
    (value: string) => {
      if (uploadsPending > 0) return;
      // Çalışan tur asla durdurulmaz: canlı yönlendirmeyi bildiren ajana yönlendirme, diğerlerine
      // sıra (tur bitince kendiliğinden gönderilir).
      handleSubmit(value, workingTurnPlacement(workingTurnSubmitMode, store.supportsSteering));
    },
    [uploadsPending, handleSubmit, workingTurnSubmitMode, store]
  );

  useEffect(() => {
    onRegisterSubmit?.(handleSubmit);
    return () => onRegisterSubmit?.(null);
  }, [handleSubmit, onRegisterSubmit]);

  useEffect(() => {
    if (!onRegisterEditDraft) return;
    onRegisterEditDraft((target: { itemId: string; text: string }) => {
      setEditingTarget(target);
      store.setDraftText(target.text);
      requestAnimationFrame(() => editorApiRef.current?.focus());
    });
    return () => onRegisterEditDraft(null);
  }, [onRegisterEditDraft, store]);

  useEffect(() => {
    if (!onRegisterReplyDraft) return;
    onRegisterReplyDraft((quote: string) => {
      const trimmedQuote = quote.trim();
      if (!trimmedQuote) return;
      setReplyQuote(trimmedQuote);
      requestAnimationFrame(() => editorApiRef.current?.focus());
    });
    return () => onRegisterReplyDraft(null);
  }, [onRegisterReplyDraft]);

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

  // "Şimdi gönder" sıradaki mesajın açıkça etiketli eylemidir ve turu durdurmanın (Durdur dışında)
  // tek yoludur; onay penceresi açmaz. Gönder düğmesi ve Enter turu hiçbir zaman durdurmaz.
  const handleSendQueuedPromptNow = useCallback(
    (id: string) => {
      store.sendQueuedPromptNow(id);
    },
    [store]
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      store.setModel(modelId);
      if (providerId) {
        recordLastUsedAgent({ providerId, model: modelId, effort: store.effort });
      }
    },
    [store, providerId]
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
      if (providerId) {
        recordLastUsedAgent({ providerId, model: store.model, effort: effortId });
      }
    },
    [store, providerId]
  );

  const handleAttach = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const addFileMentions = useCallback(
    async (files: File[]) => {
      setUploadsPending((count) => count + 1);
      try {
        const regularFiles = files.filter((file) => !shouldUseAcpImageAttachment(file));
        const uploaded = await Promise.all(
          regularFiles.map(async (file): Promise<AcpPromptAttachment | null> => {
            const mimeType = droppedFileMimeType(file);
            try {
              const ref = await uploadDroppedFile(store, file, mimeType);
              if (!ref) return null;
              const previewUrl = mimeType.startsWith('video/')
                ? URL.createObjectURL(file)
                : undefined;
              return {
                ref: { type: 'attachment', id: ref.id, name: ref.name, mimeType: ref.mimeType },
                previewUrl,
              };
            } catch (error) {
              toast.error('Dosya eklenemedi', {
                description: error instanceof Error ? error.message : file.name,
              });
              return null;
            }
          })
        );
        store.addDraftAttachments(
          uploaded.filter((entry): entry is AcpPromptAttachment => entry !== null)
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
            .map((file) => file.name || 'isimsiz görsel')
            .join(', ');
          toast.error('Desteklenmeyen görsel formatı', {
            description: `${unsupportedNames} eklenemedi. PNG, JPEG, GIF veya WebP kullanın.`,
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

  const attachDroppedFiles = useCallback(
    async (files: File[]) => {
      if (!store.liveActionsEnabled || files.length === 0) return;
      const images = files.filter(shouldUseAcpImageAttachment);
      await Promise.all([addImageFiles(images), addFileMentions(files)]);
      editorApiRef.current?.focus();
    },
    [store, addImageFiles, addFileMentions]
  );

  useEffect(() => {
    onRegisterDropFiles?.(attachDroppedFiles);
    return () => onRegisterDropFiles?.(null);
  }, [attachDroppedFiles, onRegisterDropFiles]);

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
      if (payload.files && payload.files.length > 0) {
        await attachDroppedFiles(payload.files);
      }
      editorApiRef.current?.focus();
    });
  }, [store, addImageFiles, attachDroppedFiles]);

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

  // Sağlayıcı kataloğu (T3 tarzı 3 sütunlu birleşik seçici ve aynı sohbette geçiş).
  const connectionId = getProjectSshConnectionId(store.projectId);
  const host = useMemo(() => hostRefFromConnectionId(connectionId), [connectionId]);
  const antigravitySettings = useAgentSettings('antigravity', host);
  const [optimisticOrchestrator, setOptimisticOrchestrator] = useState<
    ProviderOrchestratorConfig | undefined
  >(undefined);
  useEffect(() => {
    setOptimisticOrchestrator(antigravitySettings.value?.orchestrator);
  }, [antigravitySettings.value?.orchestrator]);
  const { data: fullAgents } = useAgents(host);
  const { data: installStatuses } = useAgentInstallationStatuses(host);
  const hasConversationMessages = store.messageCount > 0 || store.prefixTurnCount > 0;
  const handoffActive = hasConversationMessages && providerId !== null;
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
        agent.capabilities.models.kind === 'selectable'
          ? agent.capabilities.models.modelOptions
          : {};
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
      const liveModels =
        isCurrent && store.modelOptions && Object.keys(store.modelOptions).length > 0
          ? store.modelOptions
          : null;
      // Ne canlı ne statik model listesi olan ajan (çoğu kullanıcı ACP ajanı): seçicide tek bir
      // "Varsayılan" satırı kalır, tetikleyici kalıcı "Model…" yerine ajanın adını gösterir.
      const modelless = !liveModels && Object.keys(localizedStaticModels).length === 0;
      const models =
        liveModels ?? (modelless ? { __default__: { name: 'Varsayılan' } } : localizedStaticModels);
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
        ...(modelless ? { modelless } : {}),
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
      const resolvedModelId = targetModelId === '__default__' ? undefined : targetModelId;
      if (!providerId || targetProviderId === providerId) {
        if (!store.liveActionsEnabled) return;
        if (resolvedModelId && targetEffortId) {
          store.setModelAndEffort(resolvedModelId, targetEffortId);
          if (providerId) {
            recordLastUsedAgent({ providerId, model: resolvedModelId, effort: targetEffortId });
          }
        } else if (resolvedModelId) {
          store.setModel(resolvedModelId);
          if (providerId) {
            recordLastUsedAgent({ providerId, model: resolvedModelId, effort: store.effort });
          }
        } else if (targetEffortId) {
          store.setEffort(targetEffortId);
          if (providerId) {
            recordLastUsedAgent({ providerId, model: store.model, effort: targetEffortId });
          }
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
      const rawTargetName = resolvedModelId
        ? (targetAgentEntry?.models[resolvedModelId]?.name ?? resolvedModelId)
        : (targetAgentEntry?.name ?? targetProviderId);
      void switchConversationProviderInPlace({
        projectId: store.projectId,
        taskId: store.taskId,
        sourceConversationId: store.conversationId,
        sourceProviderId: providerId as AgentProviderId,
        sourceModelLabel: cleanDividerModelLabel(providerId, rawSourceName),
        sourceProviderLabel: currentAgentEntry?.name,
        targetProviderId: targetProviderId as AgentProviderId,
        ...(resolvedModelId ? { targetModel: resolvedModelId } : {}),
        targetModelLabel: cleanDividerModelLabel(targetProviderId, rawTargetName),
        ...(targetEffortId ? { targetEffort: targetEffortId } : {}),
        ...(store.permissionMode && AUTO_PERMISSION_MODES.has(store.permissionMode)
          ? { sourceAutoApprove: true }
          : {}),
        sourcePermissionMode: store.permissionMode,
        isEmpty: store.messageCount === 0,
        hasPrefixTurns: store.prefixTurnCount > 0,
        isWorking: store.affordances.isWorking,
        draftText: store.draftText,
        visibleTurns: () => store.visibleTurns(),
      });
    },
    [providerId, store, disabledReason, providerCatalog]
  );

  const orchestratorRightPanel = useCallback(
    (ctx: ModelPickerRightPanelContext) => {
      if (ctx.providerId !== 'antigravity' || !ORCHESTRATOR_PRESET_IDS.has(ctx.modelId)) {
        return null;
      }
      const normalized = normalizeProviderOrchestratorConfig(
        optimisticOrchestrator ?? antigravitySettings.value?.orchestrator
      );
      const updateRole = (field: 'plannerModel' | 'executorModel', slug: string) => {
        const nextConfig: ProviderOrchestratorConfig = {
          ...(normalized ?? {}),
          defaultMode: ctx.modelId as AntigravityOrchestratorMode,
          [field]: slug,
        };
        setOptimisticOrchestrator(nextConfig);
        antigravitySettings.update({ orchestrator: nextConfig });
      };
      const presetShort =
        ctx.modelName.replace(/^Orchestrator\s*/i, '').replace(/[()]/g, '') || ctx.modelName;

      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="text-xs font-medium text-foreground-muted">Orkestratör</span>
              <span className="truncate text-[11px] text-foreground">{presetShort}</span>
            </div>
            {ctx.isSelectedRow ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                Aktif
              </span>
            ) : (
              <button
                type="button"
                onClick={ctx.selectCurrentModel}
                className="cursor-pointer rounded bg-foreground/[0.08] px-2 py-0.5 text-[10.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.15]"
              >
                Seç
              </button>
            )}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            <AntigravityRoleSelectorBlock
              title="Planlayıcı"
              families={ANTIGRAVITY_PLANNER_FAMILIES}
              selectedSlug={normalized?.plannerModel}
              onSelectSlug={(slug) => updateRole('plannerModel', slug)}
            />
            <div className="border-t border-border/70 pt-2.5">
              <AntigravityRoleSelectorBlock
                title="Alt Ajan (Uygulayıcı)"
                families={ANTIGRAVITY_EXECUTOR_FAMILIES}
                selectedSlug={normalized?.executorModel}
                onSelectSlug={(slug) => updateRole('executorModel', slug)}
              />
            </div>
          </div>
        </div>
      );
    },
    [optimisticOrchestrator, antigravitySettings]
  );

  const providerSwitchHint = useCallback(
    (browsedProviderId: string): string | null => {
      if (!providerId || !browsedProviderId || browsedProviderId === providerId) return null;
      return hasConversationMessages
        ? 'Aynı sohbette bağlam aktarımı ile geçilir'
        : 'Sohbet bu yapay zeka ile başlar';
    },
    [providerId, hasConversationMessages]
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
          <div className="flex shrink-0 gap-1">
            {store.loadError.kind === 'session_not_found' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => confirmContinueWithNewSession(store)}
              >
                Yeni oturumla devam et
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => store.retry()}>
              Tekrar Dene
            </Button>
          </div>
        </div>
      )}
      <div ref={attachComposerScope}>
        {uploadsPending > 0 && (
          <div role="status" className="px-4 py-1 text-xs">
            Dosyalar yükleniyor…
          </div>
        )}
        <ContextHandoffBanner
          store={store}
          limitBannerVisible={limitBanner.show}
          providerLabel={agentOptions.find((option) => option.id === providerId)?.name}
        />
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
          headerSlot={
            editingTarget || replyQuote ? (
              <div className="flex flex-col gap-1 px-3 pt-2">
                {editingTarget && (
                  <EditMessageChip
                    text={editingTarget.text}
                    onCancel={() => {
                      setEditingTarget(null);
                      store.setDraftText('');
                    }}
                  />
                )}
                {replyQuote && (
                  <ReplyQuoteChip quote={replyQuote} onClear={() => setReplyQuote(null)} />
                )}
              </div>
            ) : undefined
          }
          onCompact={() => handleSubmit('/compact')}
          compactDisabled={!a.canSubmit || a.isWorking || uploadsPending > 0}
          onMoveToNewContext={() => void moveConversationToNewContext(store)}
          moveToNewContextDisabled={
            Boolean(disabledReason) || !(store.messageCount > 0 || store.prefixTurnCount > 0)
          }
          isWorking={a.isWorking}
          // Gönderim ajan durumuna bağlı değildir: bağlantı yoksa mesaj taslakta kalır ve neden
          // aşağıdaki notta görünür (bkz. AcpChatStore.submitRoute).
          canSubmit={uploadsPending === 0}
          onSubmit={handleSubmit}
          onSubmitWhileWorking={uploadsPending === 0 ? handleSubmitWhileWorking : undefined}
          notice={
            store.submitHoldReason
              ? { variant: 'warning', message: store.submitHoldReason }
              : undefined
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
          queueAgentName={agentOptions.find((option) => option.id === providerId)?.name}
          editorApiRef={editorApiRef}
          modelOptions={store.modelOptions}
          selectedModel={store.model ?? undefined}
          onModelChange={store.liveActionsEnabled ? handleModelChange : undefined}
          effortOptions={store.effortOptions}
          selectedEffort={store.effort ?? undefined}
          onEffortChange={store.liveActionsEnabled ? handleEffortChange : undefined}
          onModelAndEffortChange={
            store.liveActionsEnabled
              ? (modelId, effortId) => {
                  store.setModelAndEffort(modelId, effortId);
                  if (providerId) {
                    recordLastUsedAgent({ providerId, model: modelId, effort: effortId });
                  }
                }
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
          rightPanelOverride={orchestratorRightPanel}
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
            <div className="flex items-center gap-0.5">
              <ComposerStashMenu
                entries={stash.entries}
                open={stash.menuOpen}
                onOpenChange={stash.setMenuOpen}
                canStash={stash.canStash && uploadsPending === 0}
                onStash={stash.stash}
                onRestore={stash.restore}
                onDelete={stash.remove}
              />
              <ComposerUsageRing providerId={providerId} host={host} />
              <ManualCompactButton
                onClick={() => handleSubmit('/compact')}
                disabled={!a.canSubmit || a.isWorking || uploadsPending > 0}
              />
              <DictationButton
                editorApiRef={editorApiRef}
                shortcutScope={composerSlot}
                disabled={Boolean(disabledReason)}
                onSubmitAfterDictation={handleSubmit}
              />
            </div>
          }
          onImageFilesDropped={
            store.liveActionsEnabled ? (files) => void addImageFiles(files) : undefined
          }
          onFilesDropped={
            store.liveActionsEnabled ? (files) => void handleFilesDropped(files) : undefined
          }
          onViewImage={(att) => {
            const visualItems: Array<{ entryId: string; item: MediaViewerItem }> = attachments
              .filter(
                (entry): entry is ComposerAttachment & { previewUrl: string } =>
                  (entry.kind === 'image' || entry.kind === 'video') &&
                  typeof entry.previewUrl === 'string' &&
                  entry.previewUrl.length > 0
              )
              .map((entry) => ({
                entryId: entry.id,
                item: {
                  src: entry.previewUrl,
                  alt: entry.name,
                  kind: entry.kind === 'video' ? 'video' : 'image',
                  downloadName: entry.name,
                },
              }));
            const idx = visualItems.findIndex((x) => x.entryId === att.id);
            if (visualItems.length > 0 && idx >= 0) {
              onViewerOpen(
                visualItems.map((x) => x.item),
                idx
              );
              return;
            }
            if (att.previewUrl) {
              onViewerOpen(
                [
                  {
                    src: att.previewUrl,
                    alt: att.name,
                    kind: att.kind === 'video' ? 'video' : 'image',
                    downloadName: att.name,
                  },
                ],
                0
              );
            }
          }}
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
  const editDraftRef = useRef<((target: { itemId: string; text: string }) => void) | null>(null);
  const registerEditDraft = useCallback(
    (edit: ((target: { itemId: string; text: string }) => void) | null) => {
      editDraftRef.current = edit;
    },
    []
  );
  const replyDraftRef = useRef<((quote: string) => void) | null>(null);
  const registerReplyDraft = useCallback((reply: ((quote: string) => void) | null) => {
    replyDraftRef.current = reply;
  }, []);
  const dropFilesRef = useRef<((files: File[]) => Promise<void>) | null>(null);
  const registerDropFiles = useCallback((handler: ((files: File[]) => Promise<void>) | null) => {
    dropFilesRef.current = handler;
  }, []);
  const [isPanelDragOver, setIsPanelDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  useEffect(() => {
    const clearDrag = () => {
      dragDepthRef.current = 0;
      setIsPanelDragOver(false);
    };
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('drop', clearDrag);
    window.addEventListener('blur', clearDrag);
    return () => {
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('blur', clearDrag);
    };
  }, []);
  const viewerDisposersRef = useRef<Array<() => void>>([]);
  const [viewer, setViewer] = useState<{ items: MediaViewerItem[]; initialIndex: number } | null>(
    null
  );
  const closeViewer = useCallback(() => {
    for (const dispose of viewerDisposersRef.current.splice(0)) {
      dispose();
    }
    setViewer(null);
  }, []);
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

  const isHistoryLoading = useObserver(() => (store ? store.historyLoading : false));
  useEffect(() => {
    if (!store) return;
    const scrollToTarget = (itemId: string) => {
      requestAnimationFrame(() => {
        viewRef.current?.scrollToItem(itemId, { behavior: 'smooth' });
      });
    };
    if (!isHistoryLoading) {
      const pending = consumePendingScrollToMessage(store.conversationId);
      if (pending) scrollToTarget(pending);
    }
    return onScrollToMessageRequest((req) => {
      if (req.conversationId !== store.conversationId) return;
      const consumed = consumePendingScrollToMessage(store.conversationId) ?? req.itemId;
      scrollToTarget(consumed);
    });
  }, [store, isHistoryLoading]);

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

  const handleViewerOpen = useCallback((items: MediaViewerItem[], initialIndex = 0) => {
    setViewer({ items, initialIndex });
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
    const artifactResolver = store
      ? createTranscriptArtifactResolver({ projectId: store.projectId, taskId: store.taskId })
      : undefined;
    // Video/audio/PDF stream through `orkestra-media://` without buffering; saving runs in main.
    const artifactMediaUrl = store
      ? createTranscriptArtifactMediaUrl({ projectId: store.projectId, taskId: store.taskId })
      : undefined;
    const artifactSaver = store
      ? createTranscriptArtifactSaver({ projectId: store.projectId, taskId: store.taskId })
      : undefined;
    const saveArtifact = artifactSaver
      ? async (artifact: Parameters<NonNullable<ChatCommands['saveArtifact']>>[0]) => {
          try {
            const path = await artifactSaver(artifact);
            if (path) toast.success('Çıktı kaydedildi', { description: path });
          } catch (error) {
            toast.error('Çıktı kaydedilemedi', {
              description: error instanceof Error ? error.message : String(error),
            });
          }
        }
      : undefined;
    return {
      ...subagentCommands,
      mcpApps:
        store && providerId
          ? createChatMcpAppHost({
              conversationId: store.conversationId,
              providerId,
              host,
              sendMessage: (text) => submitMcpAppMessage(store, text),
            })
          : undefined,
      // "[Bağlam devri] …" isteği tam kullanıcı kartı yerine kısa bir bildirim olarak görünür.
      systemNotice: contextHandoffSystemNotice,
      onEditMessage: store
        ? (arg) => {
            if (!store.liveActionsEnabled) return;
            if (editDraftRef.current) {
              editDraftRef.current({ itemId: arg.itemId, text: arg.text });
            } else {
              store.setDraftText(arg.text);
            }
          }
        : undefined,
      onForkFromMessage: store
        ? (arg) => {
            void forkConversation(
              {
                conversationId: store.conversationId,
                projectId: store.projectId,
                taskId: store.taskId,
                visibleTurns: () => store.visibleTurns(),
                isWorking: () => store.affordances.isWorking,
                permissionMode: () => store.permissionMode,
                effort: () => store.effort,
              },
              { upToItemId: arg.itemId }
            );
          }
        : undefined,
      onReplyToMessage: store
        ? (arg) => {
            if (!store.liveActionsEnabled) return;
            const trimmed = arg.text.trim();
            if (!trimmed) return;
            if (replyDraftRef.current) {
              replyDraftRef.current(trimmed);
            } else {
              const quote = formatReplyQuote(trimmed);
              const current = store.draftText;
              store.setDraftText(
                current.trim() ? `${current.replace(/\s*$/, '')}\n\n${quote}` : quote
              );
            }
          }
        : undefined,
      onRetryMessage: store
        ? (arg) => {
            if (!store.liveActionsEnabled) return;
            if (store.affordances.isWorking) {
              toast.warning('Önce mevcut yanıtı durdurun.');
              return;
            }
            const prompt = findPrecedingUserPromptText(store.visibleTurns(), arg.itemId);
            if (!prompt) {
              toast.warning('Yeniden üretilecek kullanıcı istemi bulunamadı.');
              return;
            }
            void branchConversationFromBeforeItem({
              projectId: store.projectId,
              taskId: store.taskId,
              sourceConversationId: store.conversationId,
              targetItemId: arg.itemId,
              visibleTurns: store.visibleTurns(),
              autoSendPromptText: prompt,
              permissionMode: store.permissionMode,
              effort: store.effort,
            }).catch((error: unknown) => {
              toast.error('Yanıtı yeniden üretmek için yeni dal açılamadı', {
                description: error instanceof Error ? error.message : String(error),
              });
            });
          }
        : undefined,
      resolveArtifact: artifactResolver,
      mediaUrlForArtifact: artifactMediaUrl,
      saveArtifact,
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
        const gallerySource =
          arg.gallery && arg.gallery.length > 0
            ? arg.gallery
            : [
                {
                  id: arg.attachment.id,
                  src: arg.attachment.dataUrl,
                  alt: arg.attachment.name,
                  kind: arg.kind,
                  attachment: arg.attachment,
                },
              ];
        const initialIndex = arg.index ?? 0;

        const resolveEntrySrc = async (
          entry: (typeof gallerySource)[number]
        ): Promise<string | undefined> => {
          if (entry.src) return entry.src;
          if (!store) return undefined;
          if (entry.attachment?.id) {
            return (await resolveAttachmentDataUrl(store, entry.attachment.id)) ?? undefined;
          }
          if (entry.artifact && entry.kind === 'video' && artifactMediaUrl) {
            try {
              const res = await artifactMediaUrl(entry.artifact);
              if (res.dispose) viewerDisposersRef.current.push(res.dispose);
              return res.url;
            } catch {
              return undefined;
            }
          }
          if (entry.artifact && artifactResolver) {
            try {
              const res = await artifactResolver(entry.artifact);
              if (res.dispose) viewerDisposersRef.current.push(res.dispose);
              return res.url;
            } catch {
              return undefined;
            }
          }
          return undefined;
        };

        const toMediaItem = (
          entry: (typeof gallerySource)[number],
          resolvedSrc?: string
        ): MediaViewerItem | null => {
          const finalSrc = resolvedSrc ?? entry.src;
          if (!finalSrc) return null;
          const artifact = entry.artifact;
          const hostSaved =
            !!artifact && !!saveArtifact && !/^(?:data|blob|https?):/i.test(finalSrc);
          return {
            src: finalSrc,
            alt: entry.alt ?? arg.attachment.name,
            kind: entry.kind === 'video' ? 'video' : 'image',
            downloadName: entry.alt ?? arg.attachment.name,
            // A stream URL cannot be saved with `<a download>` (it would navigate the window).
            onDownload: hostSaved ? () => void saveArtifact(artifact) : undefined,
          };
        };

        const openResolved = async () => {
          const clickedEntry = gallerySource[initialIndex];
          const firstSrc =
            (clickedEntry?.src ?? arg.attachment.dataUrl) ||
            (clickedEntry ? await resolveEntrySrc(clickedEntry) : undefined);

          const initialItems: MediaViewerItem[] = [];
          let mappedInitialIndex = 0;
          gallerySource.forEach((entry, idx) => {
            const item = toMediaItem(entry, idx === initialIndex ? firstSrc : undefined);
            if (!item) return;
            if (idx === initialIndex) mappedInitialIndex = initialItems.length;
            initialItems.push(item);
          });

          if (initialItems.length === 0) return;
          handleViewerOpen(initialItems, mappedInitialIndex);

          if (store && gallerySource.some((entry, idx) => idx !== initialIndex && !entry.src)) {
            const urls = await Promise.all(gallerySource.map((entry) => resolveEntrySrc(entry)));
            const fullItems: MediaViewerItem[] = [];
            let fullInitialIndex = 0;
            gallerySource.forEach((entry, idx) => {
              const item = toMediaItem(
                entry,
                idx === initialIndex ? (firstSrc ?? urls[idx]) : urls[idx]
              );
              if (!item) return;
              if (idx === initialIndex) fullInitialIndex = fullItems.length;
              fullItems.push(item);
            });
            if (fullItems.length > 0) {
              setViewer((current) =>
                current ? { items: fullItems, initialIndex: fullInitialIndex } : current
              );
            }
          }
        };

        void openResolved();
      },
      resolveAttachment: (attachment) =>
        store ? resolveAttachmentDataUrl(store, attachment.id) : Promise.resolve(null),
      onViewMermaid: (arg) => {
        setMermaidViewer({
          svg: store?.chatContext.sharedCaches.renderMermaid(arg.chart) ?? null,
        });
      },
      onRewind: ({ itemId, promptId }) => {
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
          projectId: store.projectId,
          taskId: store.taskId,
          itemId,
          visibleTurns: store.visibleTurns(),
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
  }, [store, handleViewerOpen, orchestraLinks.key, providerId, host]);

  const liveSubagents = store ? store.agents : [];
  const liveRunningSubagents = liveSubagents.filter((agent) => agent.status === 'running').length;
  // Panel yalnızca iş sürerken açık kalır: yeni bir alt ajan çalışmaya başlayınca açılır, hepsi
  // bitince kendiliğinden kapanır. Kapalıyken "N alt ajan" hapıyla geçmiş yine açılabilir.
  const [liveSubagentsOpen, setLiveSubagentsOpen] = useState(liveRunningSubagents > 0);
  const prevLiveRunningRef = useRef(liveRunningSubagents);

  useEffect(() => {
    prevLiveRunningRef.current = liveRunningSubagents;
    setLiveSubagentsOpen(liveRunningSubagents > 0);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [activeConversationId]);

  useEffect(() => {
    const previous = prevLiveRunningRef.current;
    if (liveRunningSubagents > previous) setLiveSubagentsOpen(true);
    else if (previous > 0 && liveRunningSubagents === 0) setLiveSubagentsOpen(false);
    prevLiveRunningRef.current = liveRunningSubagents;
  }, [liveRunningSubagents]);

  if (!store) return null;

  const showLiveSubagentsPanel = !subagentPanel && liveSubagents.length > 0 && liveSubagentsOpen;
  const showLiveSubagentsToggle = !subagentPanel && liveSubagents.length > 0 && !liveSubagentsOpen;

  const hasVisualHistory = store.messageCount > 0 || store.prefixTurnCount > 0;
  const unavailableWithoutTranscript = store.loadError?.kind === 'unavailable' && !hasVisualHistory;
  const showComposer =
    store.loadError?.kind !== 'auth_required' && (store.historyKnown || hasVisualHistory);
  const showBlockingOverlay =
    !showComposer &&
    (store.historyLoading ||
      (store.loadError !== null && store.loadError.kind !== 'unavailable') ||
      unavailableWithoutTranscript);
  const showHero = showComposer && !hasVisualHistory && store.isEmpty && store.loadError === null;
  const canAcceptPanelDrop = showComposer && store.liveActionsEnabled;

  const handlePanelDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (
      !canAcceptPanelDrop ||
      !hasDraggedFiles(e.dataTransfer) ||
      hasDraggedWorkspaceFile(e.dataTransfer)
    ) {
      return;
    }
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsPanelDragOver(true);
  };

  const handlePanelDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (
      !canAcceptPanelDrop ||
      !hasDraggedFiles(e.dataTransfer) ||
      hasDraggedWorkspaceFile(e.dataTransfer)
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsPanelDragOver(true);
  };

  const handlePanelDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    dragDepthRef.current = 0;
    setIsPanelDragOver(false);
  };

  const handlePanelDrop = (e: React.DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setIsPanelDragOver(false);
    if (e.isDefaultPrevented() || e.nativeEvent.defaultPrevented) return;
    if (
      !canAcceptPanelDrop ||
      !hasDraggedFiles(e.dataTransfer) ||
      hasDraggedWorkspaceFile(e.dataTransfer)
    ) {
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    e.preventDefault();
    if (files.length > 0) {
      void dropFilesRef.current?.(files);
    }
  };

  return (
    <div
      ref={rootRef}
      onContextMenu={selectionMenu.onContextMenu}
      onDragEnter={handlePanelDragEnter}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
      data-chat-surface=""
      className="surface-paper relative flex h-full overflow-hidden bg-(--em-surface)"
    >
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Sohbet eylemleri transkriptin üstünde yüzmez: kendi opak şeridinde durur, böylece
            dar bölmelerde (bölünmüş görünüm, pano) metnin üstünü kapatmaz. Şerit bir container
            query kabıdır; dar olduğunda düğmeler yalnız simgeye iner. */}
        {(showComposer || showLiveSubagentsToggle) && (
          <div
            data-testid="acp-chat-header-actions"
            className="@container relative z-10 flex h-9 shrink-0 items-center justify-end gap-2 bg-(--em-surface) px-3"
          >
            {showComposer &&
              store.sessionConnecting &&
              !store.liveActionsEnabled &&
              !store.loadError && (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-0.5 text-[11px] text-foreground-muted"
                  title="Canlı oturum bağlanıyor…"
                >
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                  <span className="truncate @max-[28rem]:hidden">Canlı oturum bağlanıyor…</span>
                </span>
              )}
            {showComposer && store.loadError !== null && (
              <div className="inline-flex min-w-0 items-center gap-2 rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-0.5 text-[11px] text-amber-200">
                <span className="max-w-[260px] min-w-0 truncate" title={store.loadError.message}>
                  Önbellekten gösteriliyor · {store.loadError.message}
                </span>
                {store.loadError.kind === 'session_not_found' && (
                  <button
                    type="button"
                    onClick={() => confirmContinueWithNewSession(store)}
                    className="font-medium text-amber-100 underline decoration-amber-300/60 underline-offset-2 hover:text-white"
                  >
                    Yeni oturumla devam et
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => store.retry()}
                  className="font-medium text-amber-100 underline decoration-amber-300/60 underline-offset-2 hover:text-white"
                >
                  Tekrar Dene
                </button>
              </div>
            )}
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
                className="shrink-0"
                aria-label="Yan Sohbet"
                title="Ana sohbetin bağlamını kirletmeden geçici yan sohbet aç"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                <span className="@max-[28rem]:hidden">Yan Sohbet</span>
              </Button>
            )}
            {showComposer && !isConversationEmpty && store && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  render={
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      className="shrink-0"
                      aria-label="Dışa Aktar"
                      title="Sohbeti Markdown veya JSON olarak kopyala / indir"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span className="@max-[28rem]:hidden">Dışa Aktar</span>
                    </Button>
                  }
                />
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item
                    onClick={() => {
                      const state = store.chatState.transcript.state;
                      const turns = state.activeTurnSnapshot
                        ? [...state.displayTurns, state.activeTurnSnapshot]
                        : [...state.displayTurns];
                      const md = formatTranscriptAsMarkdown({
                        title: conversationStore?.data.title,
                        providerId: agent?.name ?? providerId,
                        model: store.model,
                        turns,
                      });
                      void navigator.clipboard.writeText(md).then(
                        () => toast.success('Sohbet Markdown olarak panoya kopyalandı'),
                        () => toast.error('Panoya kopyalanamadı')
                      );
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Markdown olarak kopyala
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={() => {
                      const state = store.chatState.transcript.state;
                      const turns = state.activeTurnSnapshot
                        ? [...state.displayTurns, state.activeTurnSnapshot]
                        : [...state.displayTurns];
                      const md = formatTranscriptAsMarkdown({
                        title: conversationStore?.data.title,
                        providerId: agent?.name ?? providerId,
                        model: store.model,
                        turns,
                      });
                      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = buildTranscriptMarkdownFilename(
                        conversationStore?.data.title
                      );
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Markdown (.md) indir
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onClick={() => store.exportTranscript('parsed')}>
                    <FileJson className="h-3.5 w-3.5" />
                    JSON transkript indir
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onClick={() => store.exportTranscript('raw')}>
                    <FileText className="h-3.5 w-3.5" />
                    Ham ACP günlüğü indir
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            )}
            {showComposer && <SpokenRepliesControl source={store} />}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <ChatTranscript
            context={store.chatContext}
            state={store.chatState}
            composer="slot"
            composerPlacement={hasVisualHistory || !store.isEmpty ? 'bottom' : 'center'}
            contentOverlay
            stickToBottom
            onReady={handleReady}
            commands={transcriptCommands}
            onAtBottomChange={setAtBottom}
            style={{ position: 'absolute', inset: 0 }}
          />
          {(showComposer || showLiveSubagentsToggle) && (
            // Şeridin alt kenarında yumuşak geçiş: kaydırılan metin keskin bir çizgide kesilmez.
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-3 bg-linear-to-b from-(--em-surface) to-transparent"
            />
          )}
        </div>
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
                      Tekrar Dene
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center">
                  <span className="text-foreground">Failed to load chat.</span>
                  <span className="text-xs text-foreground-muted">{store.loadError.message}</span>
                  <div className="mt-1 flex gap-2">
                    {store.loadError.kind === 'session_not_found' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => confirmContinueWithNewSession(store)}
                      >
                        Yeni oturumla devam et
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => store.retry()}>
                      Tekrar Dene
                    </Button>
                  </div>
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
          onRegisterEditDraft={registerEditDraft}
          onRegisterReplyDraft={registerReplyDraft}
          onRegisterDropFiles={registerDropFiles}
        />
      )}

      {showComposer &&
        composerSlot &&
        runningSubagents.length > 0 &&
        createPortal(
          <div className="pointer-events-none absolute bottom-full left-3 z-10 mb-2 flex max-w-[60%]">
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
          <div className="pointer-events-none absolute right-3 bottom-full z-10 mb-2 flex max-w-[60%] flex-col items-end">
            <ComputerUseChip
              conversationId={store.conversationId}
              remote={!!connectionId}
              working={store.affordances.isWorking}
            />
          </div>,
          composerSlot
        )}

      {showComposer &&
        composerSlot &&
        !atBottom &&
        createPortal(
          // Düğme metnin üstünde yüzmez: besteci alanının hemen üstünde, sohbet sütunu genişliğinde
          // opak bir şeritte durur (yukarıdan saydama geçer). Şerit yalnız en altta değilken
          // görünür ve yerleşimi değiştirmez; besteci üstündeki şeritlerin (devir/limit) de üstünde
          // kalır çünkü bunlar besteci yuvasının içindedir.
          <div
            data-testid="acp-jump-to-bottom"
            className="pointer-events-none absolute inset-x-0 bottom-full flex h-11 items-end justify-center bg-linear-to-t from-(--em-surface) from-65% to-transparent pb-1"
          >
            <Button
              variant="secondary"
              icon
              aria-label="En alta kaydır"
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
        <AcpSubagentsPanel
          agents={liveSubagents}
          onCancelSubagent={store ? (runId) => store.cancelSubagent(runId) : undefined}
          onClose={() => setLiveSubagentsOpen(false)}
        />
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

      {isPanelDragOver && canAcceptPanelDrop && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-foreground/30 bg-(--em-surface)/65 backdrop-blur-[2px]"
        >
          <div className="flex items-center gap-2 rounded-full border border-border bg-(--em-surface) px-4 py-2 text-xs font-medium text-foreground shadow-lg">
            <ImagePlus className="size-4" />
            <span>Sohbete eklemek için bırakın</span>
          </div>
        </div>
      )}

      <ImageViewerDialog
        open={!!viewer}
        onOpenChange={(open) => {
          if (!open) closeViewer();
        }}
        items={viewer?.items}
        initialIndex={viewer?.initialIndex}
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
