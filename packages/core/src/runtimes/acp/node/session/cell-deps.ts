import type { Logger } from '@orkestra/shared/logger';
import type { PromptAttachment, QueuedPrompt } from '#runtimes/acp/api';
import type { AcpAgentApi } from '#services/agent-plugins/api/plugins';

export interface ResolvedPromptAttachment {
  data: string;
  targetPath?: string;
  name?: string;
  mimeType: string;
}

export type ResolvePromptAttachment = (
  conversationId: string,
  attachment: PromptAttachment
) => Promise<ResolvedPromptAttachment>;

export interface SessionCellCallbacks {
  onSessionStateChanged?: () => void;
  onTranscriptChanged?: () => void;
  onClosed?: (exitCode: number | null) => void;
  onAgentEvent?: (phase: 'start' | 'stop' | 'error') => void;
  onSendQueuedPrompt?: (prompt: QueuedPrompt) => void;
}

export interface SessionCellDeps {
  conversationId: string;
  providerId: string;
  acpSessionId: string;
  agent: AcpAgentApi;
  supportsImages?: boolean;
  /** Agent advertised `_session/steering` at initialize (see `readSteeringSupport`). */
  supportsSteering?: boolean;
  resolveAttachment: ResolvePromptAttachment;
  logger: Logger;
  callbacks?: SessionCellCallbacks;
  /** Clock for turn liveness timestamps; defaults to `Date.now`. */
  now?: () => number;
}

export interface SessionPromptResult {
  queued: boolean;
  /** True when the prompt was injected into the running turn (steering). */
  steered?: boolean;
}

export interface PromptAcceptance {
  id: string;
  onAccepted(result: SessionPromptResult): void;
  resolvedAttachments: readonly ResolvedPromptAttachment[];
}
