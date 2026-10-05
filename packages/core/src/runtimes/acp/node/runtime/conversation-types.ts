import type {
  AcpStartError,
  ClearedConfigurationValues,
  ConversationNotFoundError,
  SessionMcpServer,
} from '#runtimes/acp/api';
import type { SessionCell } from '#runtimes/acp/node/session/cell';
import type { ConversationHandle } from './conversation-handle';
import type { AcpStartInput } from './types';

export type ConfigDimension = 'model' | 'effort' | 'collaborationMode';
export type ConfigOverrides = Partial<Record<ConfigDimension, string>>;
export type ActivationStartError = AcpStartError | ConversationNotFoundError;

export interface ConnectionLeaseState {
  release: boolean;
}

export interface SessionRecord {
  conversation: ConversationHandle;
  epoch: number;
  input: AcpStartInput;
  resumeOutcome: 'loaded' | null;
  /** Stored selections the session did not offer, cleared during materialization (key → value). */
  clearedConfiguration: ClearedConfigurationValues;
  /** Stored selections applied under the provider's own option id during materialization. */
  resolvedConfiguration: ConfigOverrides;
  processKey: string;
  processGeneration: number;
  connectionLeaseState: ConnectionLeaseState;
  cell: SessionCell;
  mcpServers: SessionMcpServer[];
  machineStateBinding: { dispose(): void };
  disposed: boolean;
}
