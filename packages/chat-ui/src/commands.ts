/**
 * ChatCommands and ScrollToItemOptions — host-injectable callback contracts.
 *
 * Extracted from index.tsx so that internal modules (chat-view, ChatRoot,
 * CommandsContext) can import these types without creating a circular
 * dependency through the package entry point.
 */

import type {
  McpAppCallToolResult,
  McpAppCsp,
  McpAppPermissions,
  McpAppToolInfo,
  TranscriptArtifact,
  TranscriptMcpCallResult,
} from '@orkestra/core/runtimes/acp/api/client';
import type { ChatImageAttachment, SubagentPhase, SubagentSource } from './model';

export interface ChatMediaGalleryItem {
  id?: string;
  src?: string;
  alt?: string;
  kind?: 'image' | 'video';
  mimeType?: string;
  attachment?: ChatImageAttachment;
  artifact?: TranscriptArtifact;
}

/** A completed MCP tool call that may come with an interactive MCP app. */
export interface ChatMcpAppCall {
  itemId: string;
  toolCallId: string;
  /** Server name as the provider reported it. */
  server: string;
  tool: string;
  input?: Record<string, unknown>;
  result?: TranscriptMcpCallResult;
}

/** The app document and metadata the host resolved (or restored) for a call. */
export interface ChatMcpAppView {
  server: string;
  tool: string;
  resourceUri: string;
  /** Raw app HTML; the chat UI injects the CSP and bootstrap before rendering. */
  html: string;
  csp?: McpAppCsp;
  permissions?: McpAppPermissions;
  prefersBorder?: boolean;
  /** Input/result kept with the snapshot, used when the transcript no longer has them. */
  input?: Record<string, unknown>;
  result?: TranscriptMcpCallResult;
  /** The server's tool definition, passed to the app as `hostContext.toolInfo`. */
  toolDefinition?: unknown;
  /**
   * False when the app's MCP server is no longer available: the app is shown from its snapshot,
   * read-only (no tool calls, resources or messages).
   */
  live?: boolean;
}

/**
 * Host services for MCP apps. The app itself never reaches these: the chat UI brokers its
 * postMessage requests, asks the user for consent and only then calls the host.
 */
export interface ChatMcpAppHost {
  hostName: string;
  hostVersion: string;
  /** Resolves the app of a call, or null when it has none (the tool row renders as usual). */
  resolve(call: ChatMcpAppCall): Promise<ChatMcpAppView | null>;
  toolInfo(call: ChatMcpAppCall, name: string): Promise<McpAppToolInfo>;
  callTool(
    call: ChatMcpAppCall,
    name: string,
    args: Record<string, unknown>
  ): Promise<McpAppCallToolResult>;
  readResource(call: ChatMcpAppCall, uri: string): Promise<unknown>;
  /** Opens an http(s) link in the system browser. */
  openLink(url: string): Promise<void>;
  /** Posts a user message into the conversation. Omit where messages cannot be sent. */
  sendMessage?: (text: string) => Promise<void>;
}

export type ChatViewCommandId = 'chat.scrollToTop' | 'chat.scrollToBottom';

export type ChatViewCommand = {
  id: ChatViewCommandId;
  label: string;
  defaultKeybinding?: string;
};

export const CHAT_VIEW_COMMANDS = [
  {
    id: 'chat.scrollToTop',
    label: 'Scroll to top',
    defaultKeybinding: 'Mod+ArrowUp',
  },
  {
    id: 'chat.scrollToBottom',
    label: 'Scroll to bottom',
    defaultKeybinding: 'Mod+ArrowDown',
  },
] as const satisfies readonly ChatViewCommand[];

/**
 * Typed callbacks that host apps inject to respond to user actions inside the
 * chat transcript. Pass via `createChatView({ commands })` or update later
 * via `view.setCommands(commands)`.
 */
export type ChatCommands = {
  /** Host-aware resolution; dispose releases temporary object URLs. */
  resolveArtifact?: (
    artifact: TranscriptArtifact,
    options?: { signal?: AbortSignal }
  ) => Promise<{ url: string; dispose?: () => void }>;

  /** Called when the user asks to share an output (export / local-network link). */
  onShareArtifact?: (artifact: TranscriptArtifact) => void;

  /**
   * Whether a path-referenced artifact (anything not directly embeddable) is a real file on the
   * host. Paths scraped from tool output are often source text, so the card stays hidden until
   * this resolves true. Omit it, or reject (e.g. connection down), to always show the card.
   */
  artifactExists?: (
    artifact: TranscriptArtifact,
    options?: { signal?: AbortSignal }
  ) => Promise<boolean>;

  /**
   * Called when the user clicks a sub-agent row (provider-native sub-agent or Orkestra worker)
   * to follow its work, e.g. in a side panel.
   */
  onOpenSubagent?: (arg: {
    itemId: string;
    toolCallId: string;
    name: string;
    source: SubagentSource;
  }) => void;

  /**
   * Live phase for sub-agents whose progress the transcript cannot observe (Orkestra workers run
   * in their own conversations). Return undefined to keep the transcript-derived phase.
   */
  resolveSubagentPhase?: (arg: {
    toolCallId: string;
    name: string;
    source: SubagentSource;
  }) => SubagentPhase | undefined;

  /**
   * Called when the user clicks a file path in a diff header, file-op row,
   * resource-link card, or inline prose link.
   */
  onOpenFile?: (arg: {
    path: string;
    line?: number;
    itemId: string;
    source: 'diff' | 'file-op' | 'resource-link' | 'prose-link';
  }) => void;

  /**
   * Called when the user clicks an image/video attachment thumbnail inside a
   * user message bubble or assistant output gallery.
   */
  onViewImage?: (arg: {
    attachment: ChatImageAttachment;
    itemId: string;
    source: 'user-message' | 'assistant-output';
    kind?: 'image' | 'video';
    gallery?: ChatMediaGalleryItem[];
    index?: number;
  }) => void;

  /**
   * Resolve an attachment id to a displayable data URL. Used for committed
   * messages whose transcript stores attachment metadata but not bytes.
   */
  resolveAttachment?: (attachment: { id: string; name: string }) => Promise<string | null>;

  /**
   * Called when the user clicks the edit / rewrite action on a user message.
   */
  onEditMessage?: (arg: { itemId: string; text: string }) => void;

  /**
   * Called when the user clicks regenerate / retry on an assistant message.
   */
  onRetryMessage?: (arg: { itemId: string; text: string }) => void;

  /**
   * Called when the user clicks fork on an assistant message to branch into a new conversation.
   */
  onForkFromMessage?: (arg: { itemId: string; text: string }) => void;

  /**
   * Called when the user clicks reply on an assistant message to quote it into the composer.
   */
  onReplyToMessage?: (arg: { itemId: string; text: string }) => void;

  /**
   * Called when the user clicks the stop button on the current user message
   * while the agent is generating.
   */
  onStop?: (arg: { itemId: string }) => void;

  /**
   * Called when the user clicks the rewind action on a user message. Only offered for messages
   * that carry a `promptId`; the host decides what rewinding means (e.g. restore files).
   */
  onRewind?: (arg: { itemId: string; promptId: string }) => void;

  /**
   * Synchronously classify an `href` from a rendered markdown link.
   * Returns `{ kind: 'workspace-file'; path: string }` for workspace files,
   * or `{ kind: 'external' }` to keep the default external-link behavior.
   */
  classifyLink?: (href: string) => { kind: 'workspace-file'; path: string } | { kind: 'external' };

  /**
   * Called when the user clicks a Mermaid diagram block preview.
   */
  onViewMermaid?: (arg: { chart: string; blockId: string; source: 'mermaid-block' }) => void;

  /** Interactive MCP apps below MCP tool calls. Omit to render those calls as plain tool rows. */
  mcpApps?: ChatMcpAppHost;

  /**
   * Called when the user clicks a resolved @-mention chip in the transcript.
   * `id` is the stable identifier (e.g. a file path); `label` is the raw @-token text.
   */
  onClickMention?: (arg: {
    id: string;
    label: string;
    kind: 'file' | 'issue' | 'symbol' | 'custom';
    itemId: string;
    source: 'prose-mention';
  }) => void;
};

export type ScrollToItemOptions = {
  /** Where to align the row within the viewport. Default: 'start'. */
  align?: 'start' | 'center' | 'end';
  /** Additional pixel offset applied after alignment. Default: 0. */
  offset?: number;
  /** Native scroll behavior. Default: 'auto'. */
  behavior?: ScrollBehavior;
};
