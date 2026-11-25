import { Button } from '@react/primitives/button';
import { cx } from '@styles/utilities/cx';
import {
  ArrowUp,
  CircleAlert,
  FileText,
  Film,
  Info,
  ListTodo,
  Music,
  Paperclip,
  Play,
  ShieldCheck,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Combobox } from '@/react/primitives/combobox/combobox';
import { Popover } from '@/react/primitives/popover';
import { Select } from '@/react/primitives/select';
import { Tooltip } from '@/react/primitives/tooltip';
import { McpIcon } from '../mcp-icon/mcp-icon';
import { PromptEditor } from '../prompt-editor/prompt-editor';
import type { PromptEditorModel } from '../prompt-editor/prompt-editor-model';
import type {
  CommandItem,
  ContextMentionProvider,
  MentionItem,
  PromptEditorRef,
  RenderMentionIcon,
} from '../prompt-editor/types';
import { buildHandoffAgentGroups } from './agent-handoff-groups';
import { ContextUsageIndicator } from './context-usage-indicator';
import type { ContextUsage } from './context-usage-indicator';
import type { ComposerProviderCatalogEntry } from './model-effort-groups';
import { ModelEffortMenu, type ModelPickerRightPanelContext } from './model-effort-menu';
import { PermissionBand } from './permission-band';
import type { ComposerPermissionRequest } from './permission-band';
import { QueuedPromptsBand } from './queued-prompts-band';
import type { ComposerQueuedPrompt } from './queued-prompts-band';
import * as styles from './chat-composer.css';
import { composerThemeScope } from './composer-contract.css';

export type { MentionItem, CommandItem };
export type {
  MentionKind,
  CommandBehavior,
  ContextMentionProvider,
  PromptEditorRef,
  RenderMentionIcon,
} from '../prompt-editor/types';
export type { ContextUsage } from './context-usage-indicator';
export type { ComposerProviderCatalogEntry } from './model-effort-groups';
export type { ModelPickerRightPanelContext } from './model-effort-menu';
export type { ComposerQueuedPrompt } from './queued-prompts-band';

export type ComposerNoticeVariant = 'error' | 'warning' | 'info';

export interface ComposerNotice {
  variant: ComposerNoticeVariant;
  title?: string;
  message: string;
  /** When provided, renders a dismiss button. */
  onDismiss?: () => void;
}

/**
 * Map an ACP stop reason to a composer notice. Returns null for reasons that
 * are not user-facing errors (end_turn, cancelled, unknown). Accepts a plain
 * string so callers can forward the ACP StopReason without this package
 * importing the ACP SDK.
 */
export function stopReasonNotice(reason: string): ComposerNotice | null {
  switch (reason) {
    case 'max_turn_requests':
      return {
        variant: 'error',
        title: 'İstek sınırına ulaşıldı',
        message:
          'Ajan bu yanıt için istek sınırına ulaştı. Devam etmek için yeni bir mesaj gönderin.',
      };
    case 'max_tokens':
      return {
        variant: 'error',
        title: 'Yanıt tamamlanamadı',
        message: 'Yanıt uzunluk sınırına ulaştığı için kesildi.',
      };
    case 'refusal':
      return {
        variant: 'error',
        title: 'İstek reddedildi',
        message: 'Ajan bu isteği yerine getirmeyi reddetti.',
      };
    default:
      return null;
  }
}

// ── Attachment types ──────────────────────────────────────────────────────────

const imageFileExtension = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;

export interface ComposerAttachment {
  id: string;
  name: string;
  /** Absolute or relative path — populated by the host for file-kind attachments. */
  path?: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  /**
   * Media source for the preview `<img>` / `<video>`. A `data:` or `blob:` URL
   * for dropped media.
   */
  previewUrl?: string;
  /** MIME type of the attachment (e.g. `image/png`, `video/mp4`) — used when sending to the agent. */
  mimeType?: string;
}

/**
 * Read a dropped image file into a `ComposerAttachment` with a `data:` URL
 * preview. On read failure the attachment is still created (without
 * `previewUrl`) so the host shows a fallback tile rather than dropping it.
 */
function readImageAttachment(file: File): Promise<ComposerAttachment> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        kind: 'image',
        previewUrl: typeof reader.result === 'string' ? reader.result : undefined,
        mimeType: file.type,
      });
    reader.onerror = () =>
      resolve({ id: crypto.randomUUID(), name: file.name, kind: 'image', mimeType: file.type });
    reader.readAsDataURL(file);
  });
}

// ── Model option types ────────────────────────────────────────────────────────

/** Minimal model descriptor the composer needs to render the model selector. */
export interface ComposerModelOption {
  name: string;
  description?: string;
  /** Optional capability metadata shown in the hover card detail. */
  modelFeatures?: {
    contextWindowSize?: number;
    speed?: number;
    intelligence?: number;
  };
}

// ── Effort option types ───────────────────────────────────────────────────────

/** Minimal effort/thought-level descriptor the composer needs to render the effort submenu. */
export interface ComposerEffortOption {
  name: string;
  description?: string;
}

// ── Permission mode option types ──────────────────────────────────────────────

/** Minimal mode descriptor the composer needs to render the permission-mode selector. */
export interface ComposerPermissionModeOption {
  name: string;
  description?: string;
}

/** Minimal collaboration-mode descriptor, such as Codex Default / Plan. */
export interface ComposerCollaborationModeOption {
  name: string;
  description?: string;
}

export interface ComposerMcpServer {
  name: string;
  transport?: string;
  startupError?: string;
}

// ── Agent option types ────────────────────────────────────────────────────────

/** Minimal agent descriptor the composer needs to render the agent selector. */
export interface ComposerAgentOption {
  id: string;
  name: string;
  /**
   * Host-rendered icon — the app's AgentIcon is theme/registry aware, which
   * this package can't reach. Shown in the trigger and each list row.
   */
  icon?: React.ReactNode;
  description?: string;
  /** e.g. not installed — shown but not selectable. */
  disabled?: boolean;
  /** Optional grouping header, e.g. "Installed" / "Not installed". */
  groupLabel?: string;
  /**
   * Short status chip shown after the name (e.g. "limit doldu"). Host-supplied because this
   * package cannot reach desktop usage data. Never blocks selection.
   */
  badge?: ComposerAgentBadge;
}

/** Short status chip rendered on an agent row. */
export interface ComposerAgentBadge {
  label: string;
  tone?: 'muted' | 'warning' | 'danger';
  /** Longer explanation, shown as the chip's tooltip. */
  title?: string;
}

/**
 * How the agent selector behaves once the conversation has history.
 * - `locked`: the agent cannot change (disabled icon button).
 * - `handoff`: the selector opens; picking another agent calls `onAgentChange` so the host can
 *   continue the work in a new conversation with that agent (the current one is untouched).
 */
export type ComposerAgentSwitchMode = 'locked' | 'handoff';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ChatComposerProps {
  disabled?: boolean;
  isWorking?: boolean;
  /** False while the session is still starting up. Blocks Send/Enter but keeps the editor typeable. */
  canSubmit?: boolean;
  /** Hide the submit/stop control for draft-only composer surfaces. */
  showSubmitButton?: boolean;
  /** Host-owned serialized editor value. Omit to keep the editor internally managed. */
  value?: string;
  /** Override the idle editor placeholder. Disabled/working placeholders still take precedence. */
  placeholder?: string;

  agentOptions?: ComposerAgentOption[] | null;
  selectedAgent?: string;
  onAgentChange?: (agentId: string) => void;
  /** Unified multi-provider catalog (T3-style 3-column picker). */
  providerCatalog?: ComposerProviderCatalogEntry[] | null;
  onProviderModelChange?: (providerId: string, modelId: string, effortId?: string) => void;
  providerSwitchHint?: (browsedProviderId: string) => string | null;
  rightPanelOverride?: (ctx: ModelPickerRightPanelContext) => React.ReactNode | null;
  /**
   * True once the session has history (any prompt sent). ACP cannot switch
   * agents mid-conversation, so the trigger becomes a disabled icon button.
   */
  agentLocked?: boolean;
  /**
   * Only meaningful together with `agentLocked`. `handoff` keeps the selector open for
   * "continue with another agent" instead of locking it. Defaults to `locked`.
   */
  agentSwitchMode?: ComposerAgentSwitchMode;

  modelOptions?: Record<string, ComposerModelOption> | null;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;

  effortOptions?: Record<string, ComposerEffortOption> | null;
  selectedEffort?: string;
  onEffortChange?: (effortId: string) => void;
  /** Called when selecting both a new model and effort together from the hover submenu. */
  onModelAndEffortChange?: (modelId: string, effortId: string) => void;

  permissionModeOptions?: Record<string, ComposerPermissionModeOption> | null;
  selectedPermissionMode?: string;
  onPermissionModeChange?: (modeId: string) => void;

  collaborationModeOptions?: Record<string, ComposerCollaborationModeOption> | null;
  selectedCollaborationMode?: string;
  onCollaborationModeChange?: (modeId: string) => void;
  mcpServers?: ComposerMcpServer[];

  onSubmit: (text: string) => void;
  /** Called whenever the editor serialized plain text changes. */
  onInputChange?: (text: string) => void;
  /** Called after a mention node is inserted. Raw insertText entries do not trigger this. */
  onMentionInsert?: (item: MentionItem) => void;
  /**
   * Called instead of onSubmit when the user attempts to send while the
   * session is actively working (isWorking === true). The host steers the
   * message into the turn or queues it; it must never ask or stop the turn.
   * When absent, submit attempts while working are silently ignored.
   */
  onSubmitWhileWorking?: (text: string) => void;
  onStop?: () => void;
  onAttach?: () => void;
  /**
   * Host-owned controls rendered in the toolbar's right cluster, before the attach button
   * (e.g. a dictation microphone).
   */
  toolbarAccessory?: React.ReactNode;
  /** Optional header content rendered above the prompt editor inside the composer container. */
  headerSlot?: React.ReactNode;
  /** Context-window usage data for the toolbar donut indicator. Hidden when null/undefined. */
  contextUsage?: ContextUsage | null;
  /** Called when the user triggers `/compact` from the context usage popover. */
  onCompact?: () => void;
  /** Disables the `/compact` trigger inside the context usage popover. */
  compactDisabled?: boolean;
  /** Context handoff: move the work to a new conversation. Shown in the usage popover. */
  onMoveToNewContext?: () => void;
  moveToNewContextDisabled?: boolean;

  /**
   * Host-controlled attachment list. By default the composer creates image
   * attachments itself from drag-drop and forwards them via `onAttachmentsChange`.
   * Hosts can override image handling with `onImageFilesDropped`.
   */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (next: ComposerAttachment[]) => void;
  /**
   * Called with pasted or dropped image files before the default data-url attachment path.
   * When supplied, the host owns uploading and adding preview attachments.
   */
  onImageFilesDropped?: (files: File[]) => void;
  /**
   * Called whenever files are dropped onto the composer.
   * The host should resolve real filesystem paths and insert non-image files
   * as path mentions via the `editorApiRef` (using `insertMention`).
   */
  onFilesDropped?: (files: File[]) => void;

  /**
   * Optional ref forwarded to the inner PromptEditor imperative API, giving
   * the host access to `insertMention` (and focus/clear/getText).
   */
  editorApiRef?: React.Ref<PromptEditorRef>;
  /** Conversation-owned editing model. Mutually exclusive with value. The owner clears on submit. */
  model?: PromptEditorModel;

  /**
   * Called when the user clicks an image attachment thumbnail in the preview
   * strip above the editor. Host can use this to open an image viewer dialog.
   */
  onViewImage?: (att: ComposerAttachment) => void;

  /**
   * Preferred: typed provider for @ mention suggestions.
   * When both `mentionProvider` and `queryMentions` are provided,
   * `mentionProvider` takes precedence.
   */
  mentionProvider?: ContextMentionProvider;
  /** Optional host renderer for inline mention pill icons. */
  renderMentionIcon?: RenderMentionIcon;
  /** Legacy: async callback returning @ mention suggestions for the given query. */
  queryMentions?: (query: string) => Promise<MentionItem[]>;
  /** Async callback returning / command suggestions for the given query. */
  queryCommands?: (query: string) => Promise<CommandItem[]>;
  /** Called when a / command with behavior='execute' is selected. */
  onCommand?: (item: CommandItem) => void;
  /** Session-state notice shown flush above the input (e.g. ACP stop reasons). */
  notice?: ComposerNotice | null;
  /**
   * Pending ACP permission request to show in the band above the input.
   * When present, the notice band is replaced by the permission band.
   * Pass null/undefined when no request is pending.
   */
  permissionRequest?: ComposerPermissionRequest | null;
  /** Total number of queued permission requests. Drives the "1 of N" counter. */
  permissionQueueCount?: number;
  /** Called with the chosen optionId when the user resolves a permission request. */
  onResolvePermission?: (optionId: string) => void;

  /** Prompts accepted while the agent is busy and waiting to be sent. */
  queuedPrompts?: ComposerQueuedPrompt[];
  onEditQueuedPrompt?: (id: string, text: string) => void;
  onDeleteQueuedPrompt?: (id: string) => void;
  onReorderQueuedPrompts?: (ids: string[]) => void;
  onSendQueuedPromptNow?: (id: string) => void;
  className?: string;
}

// ── Internal model item type ──────────────────────────────────────────────────

interface ModelItem {
  id: string;
  name: string;
  description?: string;
  modelFeatures?: ComposerModelOption['modelFeatures'];
}

// ── Notice band ───────────────────────────────────────────────────────────────

function NoticeBand({ notice }: { notice: ComposerNotice }) {
  return (
    <div className={styles.noticeBand({ variant: notice.variant })}>
      <div className={styles.noticeBandBody}>
        <div className={styles.noticeBandHeader}>
          <CircleAlert style={{ width: '0.875rem', height: '0.875rem', flexShrink: 0 }} />
          {notice.title && <p className={styles.noticeBandTitle}>{notice.title}</p>}
        </div>
        <p
          className={cx(styles.noticeBandMessage, notice.title && styles.noticeBandMessageIndented)}
        >
          {notice.message}
        </p>
      </div>
      {notice.onDismiss && (
        <button
          type="button"
          aria-label="Bildirimi kapat"
          onClick={notice.onDismiss}
          className={styles.noticeDismiss}
        >
          <X style={{ width: '0.875rem', height: '0.875rem' }} />
        </button>
      )}
    </div>
  );
}

// ── Agent selector ────────────────────────────────────────────────────────────

interface AgentGroup {
  label: string;
  items: ComposerAgentOption[];
}

function buildAgentGroups(options: ComposerAgentOption[]): AgentGroup[] {
  const grouped = new Map<string, ComposerAgentOption[]>();
  for (const opt of options) {
    const label = opt.groupLabel ?? '';
    const existing = grouped.get(label);
    if (existing) {
      existing.push(opt);
    } else {
      grouped.set(label, [opt]);
    }
  }
  return Array.from(grouped.entries()).map(([label, items]) => ({ label, items }));
}

interface ComposerAgentSelectorProps {
  options: ComposerAgentOption[];
  selectedId?: string;
  onSelect: (agentId: string) => void;
  locked: boolean;
  /** Started conversation: current agent stays selected, others are "continue with" targets. */
  handoff?: boolean;
  disabled: boolean;
}

function AgentBadgeChip({ badge }: { badge: ComposerAgentBadge }) {
  return (
    <span className={styles.agentBadge({ tone: badge.tone ?? 'muted' })} title={badge.title}>
      {badge.label}
    </span>
  );
}

function ComposerAgentSelector({
  options,
  selectedId,
  onSelect,
  locked,
  handoff = false,
  disabled,
}: ComposerAgentSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = selectedId ? (options.find((o) => o.id === selectedId) ?? null) : null;
  const groups = handoff ? buildHandoffAgentGroups(options, selectedId) : buildAgentGroups(options);
  const isDisabled = disabled || locked;

  const triggerLabel = selected
    ? locked
      ? `${selected.name} — sohbet başladıktan sonra ajan değiştirilemez`
      : handoff
        ? `${selected.name} — başka ajanla devam etmek için tıklayın`
        : selected.name
    : 'Ajan seçin';

  // When locked or session closed, show a static disabled icon button.
  if (isDisabled) {
    return (
      <Button
        variant="ghost"
        size="xs"
        icon
        disabled
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        {selected?.icon ?? <span style={{ width: '0.875rem', height: '0.875rem' }} />}
      </Button>
    );
  }

  return (
    <Combobox.Root
      value={selected ?? null}
      onValueChange={(item: ComposerAgentOption | null) => {
        if (!item || item.disabled) return;
        // The current agent is already running this conversation; picking it is a no-op.
        if (handoff && item.id === selectedId) {
          setOpen(false);
          return;
        }
        onSelect(item.id);
        setOpen(false);
      }}
      open={open}
      onOpenChange={(next) => setOpen(next)}
      isItemEqualToValue={(a: ComposerAgentOption, b: ComposerAgentOption) => a.id === b.id}
      filter={(item: ComposerAgentOption, query: string) =>
        item.name.toLowerCase().includes(query.toLowerCase())
      }
      autoHighlight
    >
      <Combobox.Trigger
        aria-label={triggerLabel}
        title={triggerLabel}
        className={styles.agentTrigger}
      >
        {selected?.icon ?? <span className={styles.agentIconPlaceholder} />}
      </Combobox.Trigger>
      {/* Portaled out of the composer root — must carry the theme-bridge scope. */}
      <Combobox.Content
        className={composerThemeScope}
        // Rozetli satırlarda (ör. "limit doldu") ajan adı kırpılmasın diye liste genişler.
        style={{ minWidth: options.some((option) => option.badge) ? '15rem' : '11.25rem' }}
      >
        <Combobox.Input showTrigger={false} placeholder="Ajanlarda ara…" />
        <Combobox.List>
          {groups.map((group) =>
            group.label ? (
              <Combobox.Group key={group.label}>
                <Combobox.Label>{group.label}</Combobox.Label>
                {group.items.map((item) => (
                  <Combobox.Item key={item.id} value={item} disabled={item.disabled}>
                    {item.icon && <span style={{ flexShrink: 0 }}>{item.icon}</span>}
                    <span
                      style={{
                        minWidth: 0,
                        flex: '0 1 auto',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.name}
                    </span>
                    {item.badge && <AgentBadgeChip badge={item.badge} />}
                  </Combobox.Item>
                ))}
              </Combobox.Group>
            ) : (
              group.items.map((item) => (
                <Combobox.Item key={item.id} value={item} disabled={item.disabled}>
                  {item.icon && <span style={{ flexShrink: 0 }}>{item.icon}</span>}
                  <span
                    style={{
                      minWidth: 0,
                      flex: '0 1 auto',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.name}
                  </span>
                  {item.badge && <AgentBadgeChip badge={item.badge} />}
                </Combobox.Item>
              ))
            )
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox.Root>
  );
}

interface ComposerModeItem {
  id: string;
  name: string;
  description?: string;
}

interface ComposerModeSelectProps {
  items: ComposerModeItem[];
  selectedId?: string;
  onChange?: (id: string) => void;
  disabled: boolean;
  isFirst: boolean;
  ariaLabel: string;
  placeholder: string;
  icon: React.ReactNode;
}

function ComposerModeSelect({
  items,
  selectedId,
  onChange,
  disabled,
  isFirst,
  ariaLabel,
  placeholder,
  icon,
}: ComposerModeSelectProps) {
  const selected = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;

  return (
    <Select.Root
      value={selectedId}
      onValueChange={(id) => {
        if (id) onChange?.(id);
      }}
      disabled={disabled}
    >
      <Select.Trigger
        aria-label={ariaLabel}
        title={selected ? `${ariaLabel}: ${selected.name}` : ariaLabel}
        className={cx(styles.modeTrigger, isFirst && styles.permissionModeTrigger)}
      >
        <span
          className={styles.modeLabel}
          style={{
            color: selected ? 'var(--em-foreground)' : 'var(--em-foreground-muted)',
          }}
        >
          {icon}
          <span className={styles.modeLabelText}>{selected?.name ?? placeholder}</span>
        </span>
      </Select.Trigger>
      <Select.Content
        align="start"
        width="trigger"
        className={composerThemeScope}
        style={{
          width: 'min(18rem, var(--available-width, 18rem))',
          minWidth: 0,
          maxWidth: '18rem',
        }}
      >
        {items.map((item) => (
          <Select.Item key={item.id} value={item.id}>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 'var(--em-text-sm)',
                }}
              >
                {item.name}
              </span>
              {item.description && (
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 'var(--em-text-xs)',
                    color: 'var(--em-foreground-muted)',
                  }}
                >
                  {item.description}
                </span>
              )}
            </span>
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChatComposer({
  disabled = false,
  isWorking = false,
  canSubmit = true,
  showSubmitButton = true,
  value,
  placeholder,
  agentOptions,
  selectedAgent,
  onAgentChange,
  providerCatalog,
  onProviderModelChange,
  providerSwitchHint,
  rightPanelOverride,
  agentLocked = false,
  agentSwitchMode = 'locked',
  modelOptions,
  selectedModel,
  onModelChange,
  effortOptions,
  selectedEffort,
  onEffortChange,
  onModelAndEffortChange,
  permissionModeOptions,
  selectedPermissionMode,
  onPermissionModeChange,
  collaborationModeOptions,
  selectedCollaborationMode,
  onCollaborationModeChange,
  mcpServers = [],
  onSubmit,
  onInputChange,
  onMentionInsert,
  onSubmitWhileWorking,
  onStop,
  onAttach,
  toolbarAccessory,
  headerSlot,
  contextUsage,
  onCompact,
  compactDisabled,
  onMoveToNewContext,
  moveToNewContextDisabled,
  attachments = [],
  onAttachmentsChange,
  onImageFilesDropped,
  onFilesDropped,
  editorApiRef,
  model,
  mentionProvider,
  renderMentionIcon,
  queryMentions,
  queryCommands,
  onCommand,
  onViewImage,
  notice,
  permissionRequest,
  permissionQueueCount = 1,
  onResolvePermission,
  queuedPrompts = [],
  onEditQueuedPrompt,
  onDeleteQueuedPrompt,
  onReorderQueuedPrompts,
  onSendQueuedPromptNow,
  className,
}: ChatComposerProps) {
  const mcpFailureCount = mcpServers.filter((server) => server.startupError).length;
  const editorRef = useRef<PromptEditorRef | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [editorText, setEditorText] = useState('');

  // Retain the last notice so its content stays rendered while the band
  // collapses out, letting the exit transition play before unmount.
  const [retainedNotice, setRetainedNotice] = useState<ComposerNotice | null>(notice ?? null);
  useEffect(() => {
    if (notice) setRetainedNotice(notice);
  }, [notice]);

  const handleSubmit = (text: string) => {
    // Allow image-only sends: a message with attachments but no text is valid.
    const hasImages = attachments.length > 0;
    if (!text.trim() && !hasImages) return;
    // While the agent is actively working, hand the message to the host (live
    // steering or the queue) instead of submitting a new turn.
    if (isWorking) {
      onSubmitWhileWorking?.(text);
      return;
    }
    if (disabled || !canSubmit) return;
    onSubmit(text);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const pastedFiles = Array.from(e.clipboardData.items).flatMap((item) => {
      if (item.kind !== 'file') return [];
      const file = item.getAsFile();
      return file ? [file] : [];
    });
    if (pastedFiles.length === 0) return;

    const imageFiles = pastedFiles.filter((file) => {
      const mimeType = file.type.toLowerCase();
      return mimeType.startsWith('image/') || imageFileExtension.test(file.name);
    });
    const nonImageFiles = pastedFiles.filter((file) => !imageFiles.includes(file));

    if (!e.clipboardData.types.some((type) => type.startsWith('text/'))) e.preventDefault();
    if (imageFiles.length > 0) {
      if (onImageFilesDropped) {
        onImageFilesDropped(imageFiles);
      } else if (onAttachmentsChange) {
        const base = attachments;
        void Promise.all(imageFiles.map(readImageAttachment)).then((newAttachments) => {
          onAttachmentsChange([...base, ...newAttachments]);
        });
      }
    }
    if (nonImageFiles.length > 0) {
      onFilesDropped?.(nonImageFiles);
    }
  };

  // ── Drag-and-drop ───────────────────────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when leaving the root element itself (not a child).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length > 0 && onImageFilesDropped) {
      onImageFilesDropped(imageFiles);
    } else if (imageFiles.length > 0 && onAttachmentsChange) {
      const base = attachments;
      void Promise.all(imageFiles.map(readImageAttachment)).then((newAttachments) => {
        onAttachmentsChange([...base, ...newAttachments]);
      });
    }

    onFilesDropped?.(files);
  };

  // ── Attachment removal ──────────────────────────────────────────────────────

  const removeAttachment = (id: string) => {
    const att = attachments.find((a) => a.id === id);
    if (att?.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(att.previewUrl);
    }
    onAttachmentsChange?.(attachments.filter((a) => a.id !== id));
  };

  const imageAttachments = attachments;
  const canQueuePrompt =
    isWorking &&
    !!onSubmitWhileWorking &&
    (editorText.trim().length > 0 || imageAttachments.length > 0);

  // ── Model items ─────────────────────────────────────────────────────────────

  const modelItems: ModelItem[] = modelOptions
    ? Object.entries(modelOptions).map(([id, opt]) => ({ id, ...opt }))
    : [];
  const hasUnifiedProviderCatalog = Boolean(providerCatalog && providerCatalog.length > 0);
  const selectedAgentItem =
    selectedAgent && agentOptions
      ? (agentOptions.find((a) => a.id === selectedAgent) ?? null)
      : null;
  const agentHandoff = agentLocked && agentSwitchMode === 'handoff';
  const selectedAgentTitle = selectedAgentItem
    ? hasUnifiedProviderCatalog && onProviderModelChange
      ? `${selectedAgentItem.name} — yapay zeka ve model seç`
      : agentLocked && !agentHandoff
        ? `${selectedAgentItem.name} — sohbet başladıktan sonra ajan değiştirilemez`
        : selectedAgentItem.name
    : undefined;

  // ── Effort items ─────────────────────────────────────────────────────────────

  interface EffortItem {
    id: string;
    name: string;
    description?: string;
  }

  const effortItems: EffortItem[] = effortOptions
    ? Object.entries(effortOptions).map(([id, opt]) => ({ id, ...opt }))
    : [];

  // ── Permission mode items ────────────────────────────────────────────────────

  const permissionModeItems: ComposerModeItem[] = permissionModeOptions
    ? Object.entries(permissionModeOptions).map(([id, opt]) => ({ id, ...opt }))
    : [];
  const collaborationModeItems: ComposerModeItem[] = collaborationModeOptions
    ? Object.entries(collaborationModeOptions).map(([id, opt]) => ({ id, ...opt }))
    : [];
  const collaborationModeIsFirst =
    !hasUnifiedProviderCatalog && modelItems.length === 0 && !agentOptions?.length;
  const permissionModeIsFirst =
    collaborationModeItems.length === 0 &&
    !hasUnifiedProviderCatalog &&
    modelItems.length === 0 &&
    !agentOptions?.length;

  const canShowQueuedPrompts =
    queuedPrompts.length > 0 &&
    !!onEditQueuedPrompt &&
    !!onDeleteQueuedPrompt &&
    !!onReorderQueuedPrompts &&
    !!onSendQueuedPromptNow;
  // The permission band takes priority over the notice band.
  const hasBand = canShowQueuedPrompts || !!(permissionRequest ?? notice);
  const shouldHandleSubmitAttempt = !disabled && (isWorking ? !!onSubmitWhileWorking : canSubmit);
  const resolvedPlaceholder = disabled
    ? 'Oturum kapandı'
    : isWorking
      ? 'Yeni bir mesaj yazın'
      : (placeholder ?? 'Mesaj yazın, @ ile dosya ekleyin veya / ile komut kullanın');

  return (
    <div className={cx(styles.composerRoot, composerThemeScope, className)}>
      {canShowQueuedPrompts && (
        <QueuedPromptsBand
          prompts={queuedPrompts}
          onEdit={onEditQueuedPrompt}
          onDelete={onDeleteQueuedPrompt}
          onReorder={onReorderQueuedPrompts}
          onSendNow={onSendQueuedPromptNow}
          connectToBandBelow={!!(permissionRequest && onResolvePermission)}
        />
      )}

      {/* Permission band — shown when the agent is awaiting user approval. */}
      {permissionRequest && onResolvePermission && (
        <PermissionBand
          request={permissionRequest}
          queueCount={permissionQueueCount}
          onResolve={onResolvePermission}
        />
      )}

      {/* Notice band — height + opacity animate on enter/exit via the
          grid-rows 0fr↔1fr technique so add/remove transitions are smooth.
          Hidden when the permission band is active. */}
      {!permissionRequest && (
        <div
          className={cx(
            styles.noticeAnimWrapper,
            notice ? styles.noticeAnimVisible : styles.noticeAnimHidden
          )}
          aria-hidden={!notice}
        >
          <div className={styles.noticeOverflowClip}>
            {retainedNotice && <NoticeBand notice={retainedNotice} />}
          </div>
        </div>
      )}

      <div
        className={styles.composerShell({ hasBand: !!hasBand, dragActive })}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Header slot (e.g. reply quote or edit message chips) */}
        {headerSlot ? <div className={styles.headerSlot}>{headerSlot}</div> : null}

        {/* Attachment previews (images, videos, audio, files) */}
        {imageAttachments.length > 0 && (
          <div className={styles.attachmentStrip}>
            {imageAttachments.map((att) => {
              const isVisualMedia = att.kind === 'image' || att.kind === 'video';
              if (!isVisualMedia) {
                return (
                  <div key={att.id} className={styles.attachmentFileChip} data-attachment-thumb>
                    {att.kind === 'audio' ? (
                      <Music
                        style={{
                          width: '0.875rem',
                          height: '0.875rem',
                          flexShrink: 0,
                          opacity: 0.75,
                        }}
                      />
                    ) : (
                      <FileText
                        style={{
                          width: '0.875rem',
                          height: '0.875rem',
                          flexShrink: 0,
                          opacity: 0.75,
                        }}
                      />
                    )}
                    <span title={att.name} className={styles.attachmentFileName}>
                      {att.name}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${att.name}`}
                      onClick={() => removeAttachment(att.id)}
                      className={styles.attachmentRemoveBtn}
                    >
                      <X style={{ width: '0.625rem', height: '0.625rem' }} />
                    </button>
                  </div>
                );
              }
              return (
                <div key={att.id} className={styles.attachmentThumb} data-attachment-thumb>
                  <button
                    type="button"
                    aria-label={
                      att.kind === 'video' ? `Videoyu aç: ${att.name}` : `Görseli aç: ${att.name}`
                    }
                    onClick={() => onViewImage?.(att)}
                    className={styles.attachmentThumbBtn}
                  >
                    {att.kind === 'video' ? (
                      att.previewUrl ? (
                        <>
                          <video
                            src={att.previewUrl}
                            muted
                            playsInline
                            preload="metadata"
                            className={styles.attachmentThumbImg}
                          />
                          <span className={styles.attachmentVideoBadge}>
                            <Play
                              style={{
                                width: '0.875rem',
                                height: '0.875rem',
                                fill: 'currentColor',
                              }}
                            />
                          </span>
                        </>
                      ) : (
                        <span
                          style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(255,255,255,0.06)',
                          }}
                          title={att.name}
                        >
                          <Film style={{ width: '1rem', height: '1rem', opacity: 0.85 }} />
                        </span>
                      )
                    ) : (
                      <img
                        src={att.previewUrl}
                        alt={att.name}
                        className={styles.attachmentThumbImg}
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${att.name}`}
                    onClick={() => removeAttachment(att.id)}
                    className={styles.attachmentRemoveBtn}
                  >
                    <X style={{ width: '0.625rem', height: '0.625rem' }} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Editor area */}
        <PromptEditor
          model={model}
          viewportClassName={styles.editorArea}
          ref={(handle) => {
            editorRef.current = handle;
            if (handle) setEditorText(handle.getText());
            if (editorApiRef) {
              if (typeof editorApiRef === 'function') {
                editorApiRef(handle);
              } else {
                (editorApiRef as React.MutableRefObject<PromptEditorRef | null>).current = handle;
              }
            }
          }}
          value={value}
          placeholder={resolvedPlaceholder}
          disabled={disabled}
          onChange={(text) => {
            setEditorText(text);
            onInputChange?.(text);
          }}
          onSubmit={shouldHandleSubmitAttempt ? handleSubmit : undefined}
          clearOnSubmit={model ? false : undefined}
          onMentionInsert={onMentionInsert}
          mentionProvider={mentionProvider}
          renderMentionIcon={renderMentionIcon}
          queryMentions={queryMentions}
          queryCommands={queryCommands}
          onCommand={onCommand}
          popupClassName={composerThemeScope}
        />
        {/* Toolbar */}
        <div className={styles.toolbar}>
          {/* Left: agent + model selector */}
          <div className={styles.toolbarLeft}>
            {!hasUnifiedProviderCatalog &&
              agentOptions &&
              agentOptions.length > 0 &&
              (modelItems.length === 0 || agentHandoff) && (
                <ComposerAgentSelector
                  options={agentOptions}
                  selectedId={selectedAgent}
                  onSelect={(id) => onAgentChange?.(id)}
                  locked={agentLocked && !agentHandoff}
                  handoff={agentHandoff}
                  disabled={disabled}
                />
              )}
            {(hasUnifiedProviderCatalog || modelItems.length > 0) && (
              <ModelEffortMenu
                models={modelItems}
                efforts={effortItems}
                selectedModel={selectedModel ?? null}
                selectedEffort={selectedEffort ?? null}
                onSelectModel={(id) => onModelChange?.(id)}
                onSelectEffort={(id) => onEffortChange?.(id)}
                onSelectModelAndEffort={onModelAndEffortChange}
                disabled={disabled}
                leadingIcon={!agentHandoff ? selectedAgentItem?.icon : undefined}
                triggerTitle={selectedAgentTitle}
                contentClassName={composerThemeScope}
                providers={providerCatalog ?? undefined}
                selectedProvider={selectedAgent ?? null}
                onSelectProviderModel={onProviderModelChange}
                footerHint={providerSwitchHint}
                rightPanelOverride={rightPanelOverride}
                collaborationModes={collaborationModeItems}
                selectedCollaborationMode={selectedCollaborationMode ?? null}
                onCollaborationModeChange={onCollaborationModeChange}
                permissionModes={permissionModeItems}
                selectedPermissionMode={selectedPermissionMode ?? null}
                onPermissionModeChange={onPermissionModeChange}
              />
            )}
            {collaborationModeItems.length > 0 && (
              <ComposerModeSelect
                items={collaborationModeItems}
                selectedId={selectedCollaborationMode}
                onChange={onCollaborationModeChange}
                disabled={disabled}
                isFirst={collaborationModeIsFirst}
                ariaLabel="Çalışma kipi"
                placeholder="Çalışma kipi…"
                icon={<ListTodo style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0 }} />}
              />
            )}
            {permissionModeItems.length > 0 && (
              <ComposerModeSelect
                items={permissionModeItems}
                selectedId={selectedPermissionMode}
                onChange={onPermissionModeChange}
                disabled={disabled}
                isFirst={permissionModeIsFirst}
                ariaLabel="İzin kipi"
                placeholder="İzinler…"
                icon={
                  <ShieldCheck style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0 }} />
                }
              />
            )}
            {mcpServers.length > 0 && (
              <Popover.Root>
                <Popover.Trigger
                  className={styles.mcpTrigger}
                  data-failed={mcpFailureCount > 0 ? '' : undefined}
                  openOnHover
                  aria-label={`${mcpServers.length} MCP sunucusu${mcpFailureCount ? `, ${mcpFailureCount} başlatma hatası` : ''}`}
                >
                  <McpIcon size={12} />
                  {mcpServers.length}
                </Popover.Trigger>
                <Popover.Content
                  align="start"
                  className={cx(styles.mcpPopoverContent, composerThemeScope)}
                  aria-label="Oturumun MCP sunucuları"
                  initialFocus={false}
                >
                  <div className={styles.mcpList}>
                    {mcpServers.map((server) => (
                      <div
                        key={`${server.transport}:${server.name}`}
                        className={styles.mcpRow}
                        data-failed={server.startupError ? '' : undefined}
                      >
                        <div className={styles.mcpNameGroup}>
                          <span className={styles.mcpName}>{server.name}</span>
                          {server.startupError && (
                            <Tooltip.Root>
                              <Tooltip.Trigger
                                render={<Button variant="ghost" size="xs" icon />}
                                aria-label={`${server.name} startup error`}
                              >
                                <Info className={styles.mcpInfoIcon} aria-hidden="true" />
                              </Tooltip.Trigger>
                              <Tooltip.Content role="tooltip" side="right" align="start">
                                <span className={styles.mcpErrorText}>{server.startupError}</span>
                              </Tooltip.Content>
                            </Tooltip.Root>
                          )}
                        </div>
                        {server.transport && (
                          <span
                            className={styles.mcpBadge}
                            data-failed={server.startupError ? '' : undefined}
                          >
                            {server.transport}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </Popover.Content>
              </Popover.Root>
            )}
          </div>

          {/* Right: usage donut + attach + send/stop */}
          <div className={styles.toolbarRight}>
            {contextUsage && contextUsage.size > 0 && (
              <ContextUsageIndicator
                usage={contextUsage}
                disabled={disabled}
                onCompact={onCompact}
                compactDisabled={compactDisabled}
                onMoveToNewContext={onMoveToNewContext}
                moveToNewContextDisabled={moveToNewContextDisabled}
              />
            )}
            {toolbarAccessory}
            {onAttach && (
              <Button
                variant="ghost"
                size="xs"
                icon
                onClick={onAttach}
                disabled={disabled}
                aria-label="Dosya ekle"
              >
                <Paperclip />
              </Button>
            )}

            {showSubmitButton ? (
              isWorking && !canQueuePrompt ? (
                <Button
                  variant="primary"
                  tone="destructive"
                  size="xs"
                  icon
                  className={styles.sendButtonRound}
                  onClick={onStop}
                  aria-label="Yanıtı durdur"
                >
                  <span className={styles.stopIcon} aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="xs"
                  icon
                  className={styles.sendButtonRound}
                  onClick={() => handleSubmit(editorRef.current?.getText() ?? '')}
                  disabled={disabled || (!isWorking && !canSubmit)}
                  aria-label={isWorking ? 'Mesajı sıraya ekle' : 'Mesaj gönder'}
                >
                  <ArrowUp />
                </Button>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
