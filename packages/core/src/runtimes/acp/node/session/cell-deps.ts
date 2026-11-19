import type { Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import type { PromptAttachment, QueuedPrompt } from '#runtimes/acp/api';
import type { SideAnswerError, SideAnswerRequest } from '#runtimes/acp/node/side/side-answer';
import type { AcpAgentApi } from '#services/agent-plugins/api/plugins';

export type SideAnswerCall = Pick<SideAnswerRequest, 'prompt' | 'signal' | 'onText' | 'model'>;

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
  /**
   * Answers a question beside the running turn with a transient read-only session. Absent when the
   * runtime cannot (no process host); the cell then never offers side answers.
   */
  sideAnswer?: (request: SideAnswerCall) => Promise<Result<void, SideAnswerError>>;
  resolveAttachment: ResolvePromptAttachment;
  logger: Logger;
  callbacks?: SessionCellCallbacks;
}

export interface SessionPromptResult {
  queued: boolean;
  /** True when the prompt was injected into the running turn (steering). */
  steered?: boolean;
  sideAnswer?: boolean;
}

export interface PromptAcceptance {
  id: string;
  onAccepted(result: SessionPromptResult): void;
  resolvedAttachments: readonly ResolvedPromptAttachment[];
}
