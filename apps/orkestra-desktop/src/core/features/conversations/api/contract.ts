import { serializedHostRefSchema } from '@orkestra/core/primitives/host/api';
import {
  runtimeResolveErrorSchema,
  type RuntimeResolveError,
} from '@orkestra/core/primitives/runtime-resolution/api';
import {
  acpApiContract,
  sessionSummarySchema,
  transcriptTurnSchema,
} from '@orkestra/core/runtimes/acp/api/client';
import { gitContract } from '@orkestra/core/runtimes/git/api';
import { tuiAgentsContract, tuiSessionListSchema } from '@orkestra/core/runtimes/tui-agents/api';
import { attachmentErrorSchema } from '@orkestra/core/services/attachments/api';
import { conversationAttachmentsContract } from '@orkestra/core/services/attachments/api';
import type { Result } from '@orkestra/shared';
import {
  defineContract,
  downloadFile,
  eventStream,
  fallible,
  liveLog,
  liveModel,
  liveState,
  procedure,
  uploadFile,
} from '@orkestra/wire/rpc';
import { z } from 'zod';
import { orchestraContractDefinitions } from '@core/features/orchestra/api/orchestra';
import { workflowContractDefinitions } from '@core/features/orchestra/api/workflow';
import {
  projectAttachmentErrorSchema,
  type ProjectAttachmentError,
} from '@core/features/projects/api/attachments';
import { codeWorkflowContractDefinitions } from '@core/features/workflows/api/contract';
import type {
  Conversation,
  ConversationEvent,
  CreateConversationParams,
  ExternalSessionSummary,
  HostConversationRow,
} from '@core/primitives/conversations/api';
import {
  localTerminalFilesSchema,
  preparedTerminalFileSchema,
} from '@core/services/attachments/api/terminal-files';
import {
  handoffBulkImportInputSchema,
  handoffListAllOutputSchema,
  handoffRecordSchema,
} from './handoff-schemas';

/**
 * Per-call byte limit of `readMediaPreview`. Base64 inflates by 4/3, so 8 MiB raw stays well inside
 * the 16 MiB remote frame budget (`REMOTE_MAX_FRAME_BYTES`) including the JSON/encryption envelope.
 */
export const MEDIA_PREVIEW_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const conversationKey = z.object({ conversationId: z.string() });
const conversationLocation = z.object({
  projectId: z.string(),
  taskId: z.string(),
  conversationId: z.string(),
});
const checkpointKey = conversationKey.extend({ seq: z.number().int().positive() });
const attachmentKey = conversationKey.extend({ attachmentId: z.string() });
const hostSessionsKey = z.object({
  host: serializedHostRefSchema,
  projectId: z.string(),
});

const projectAttachmentFailureSchema = z.object({
  success: z.literal(false),
  error: projectAttachmentErrorSchema,
});
const runtimeResolveFailureSchema = z.object({
  success: z.literal(false),
  error: runtimeResolveErrorSchema,
});

type ProjectRuntimeResult<OutputSchema extends z.ZodTypeAny> =
  z.output<OutputSchema> extends Result<infer Data, infer Error>
    ? Result<Data, Error | RuntimeResolveError | ProjectAttachmentError>
    : never;

function runtimeFallibleProcedure<
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny,
>(input: InputSchema, output: OutputSchema) {
  return procedure({
    input,
    output: z.union([
      output,
      runtimeResolveFailureSchema,
      projectAttachmentFailureSchema,
    ]) as z.ZodType<ProjectRuntimeResult<OutputSchema>>,
  });
}

function projectAttachmentErrorUnion<ErrorSchema extends z.ZodTypeAny>(error: ErrorSchema) {
  return z.union([error, runtimeResolveErrorSchema, projectAttachmentErrorSchema]);
}

const desktopAcpSessions = liveModel({
  key: hostSessionsKey,
  states: {
    list: liveState({ data: z.record(z.string(), sessionSummarySchema) }),
  },
});

const desktopTuiSessions = liveModel({
  key: hostSessionsKey,
  states: {
    list: liveState({ data: tuiSessionListSchema }),
  },
});

const conversationsAcpContract = defineContract({
  attach: runtimeFallibleProcedure(
    conversationKey.extend({
      /**
       * The user confirmed continuing with a new agent session because the saved one is definitely
       * gone (see `acpStartInputSchema.replaceUnloadableSession`). One-shot.
       */
      replaceUnloadableSession: z.literal(true).optional(),
    }),
    acpApiContract.attach.output
  ),
  terminate: runtimeFallibleProcedure(
    acpApiContract.terminate.input,
    acpApiContract.terminate.output
  ),
  sendPrompt: runtimeFallibleProcedure(
    acpApiContract.sendPrompt.input,
    acpApiContract.sendPrompt.output
  ),
  editQueuedPrompt: runtimeFallibleProcedure(
    acpApiContract.editQueuedPrompt.input,
    acpApiContract.editQueuedPrompt.output
  ),
  deleteQueuedPrompt: runtimeFallibleProcedure(
    acpApiContract.deleteQueuedPrompt.input,
    acpApiContract.deleteQueuedPrompt.output
  ),
  changeQueuePromptOrder: runtimeFallibleProcedure(
    acpApiContract.changeQueuePromptOrder.input,
    acpApiContract.changeQueuePromptOrder.output
  ),
  cancelTurn: runtimeFallibleProcedure(
    acpApiContract.cancelTurn.input,
    acpApiContract.cancelTurn.output
  ),
  cancelSubagent: runtimeFallibleProcedure(
    conversationKey.extend({ runId: z.string().uuid() }),
    acpApiContract.cancelSubagent.output
  ),
  setOption: runtimeFallibleProcedure(
    acpApiContract.setOption.input,
    acpApiContract.setOption.output
  ),
  resolvePermission: runtimeFallibleProcedure(
    acpApiContract.resolvePermission.input,
    acpApiContract.resolvePermission.output
  ),
  exportAcpTranscript: runtimeFallibleProcedure(
    acpApiContract.exportAcpTranscript.input,
    acpApiContract.exportAcpTranscript.output
  ),
  exportRawAcpLog: runtimeFallibleProcedure(
    acpApiContract.exportRawAcpLog.input,
    acpApiContract.exportRawAcpLog.output
  ),
  loadHistory: runtimeFallibleProcedure(
    acpApiContract.loadHistory.input,
    acpApiContract.loadHistory.output
  ),
  getCachedHistory: procedure({
    input: conversationKey,
    output: z.object({
      turns: z.array(transcriptTurnSchema),
      source: z.enum(['cache', 'disk', 'fts', 'empty']),
    }),
  }),
  /** Turns of earlier agent sessions of this conversation that the current agent does not remember. */
  getEarlierTurns: procedure({
    input: conversationKey,
    output: z.object({ turns: z.array(transcriptTurnSchema) }),
  }),
  sessions: desktopAcpSessions,
  session: acpApiContract.session,
  terminalOutput: liveLog({
    key: conversationKey.extend({ terminalId: z.string() }),
  }),
});

const conversationsTuiContract = defineContract({
  start: runtimeFallibleProcedure(tuiAgentsContract.start.input, tuiAgentsContract.start.output),
  resume: runtimeFallibleProcedure(tuiAgentsContract.resume.input, tuiAgentsContract.resume.output),
  stop: runtimeFallibleProcedure(tuiAgentsContract.stop.input, tuiAgentsContract.stop.output),
  delete: runtimeFallibleProcedure(tuiAgentsContract.delete.input, tuiAgentsContract.delete.output),
  kill: runtimeFallibleProcedure(tuiAgentsContract.kill.input, tuiAgentsContract.kill.output),
  sendInput: runtimeFallibleProcedure(
    tuiAgentsContract.sendInput.input,
    tuiAgentsContract.sendInput.output
  ),
  resize: runtimeFallibleProcedure(tuiAgentsContract.resize.input, tuiAgentsContract.resize.output),
  output: tuiAgentsContract.output,
  sessions: desktopTuiSessions,
});

/** File checkpoints taken before each ACP prompt; the worktree is resolved in main from the id. */
const conversationsCheckpointsContract = defineContract({
  list: runtimeFallibleProcedure(conversationKey, gitContract.checkout.listCheckpoints.output),
  preview: runtimeFallibleProcedure(
    checkpointKey,
    gitContract.checkout.previewCheckpointRestore.output
  ),
  restore: runtimeFallibleProcedure(checkpointKey, gitContract.checkout.restoreCheckpoint.output),
});

export const conversationsDomain = 'conversations' as const;

const conversationsHandoffContract = defineContract({
  listAll: procedure({
    input: z.void(),
    output: handoffListAllOutputSchema,
  }),
  put: procedure({
    input: z.object({ conversationId: z.string().min(1), record: handoffRecordSchema }),
    output: z.void(),
  }),
  remove: procedure({
    input: conversationKey,
    output: z.void(),
  }),
  markContextDelivered: procedure({
    input: conversationKey,
    output: z.void(),
  }),
  clearTargetEffort: procedure({
    input: conversationKey,
    output: z.void(),
  }),
  markSuperseded: procedure({
    input: z.object({
      oldConversationId: z.string().min(1),
      newConversationId: z.string().min(1),
    }),
    output: z.void(),
  }),
  bulkImport: procedure({
    input: handoffBulkImportInputSchema,
    output: z.void(),
  }),
  /**
   * Bağlam devri dökümlerini (`~/.orkestra/handoffs`) verilen ana makinede saklama kuralına göre
   * temizler (`context-handoff-transcript-retention.ts`). Ana makine başına seyreltilir.
   */
  pruneTranscripts: procedure({
    input: z.object({ connectionId: z.string().min(1).optional() }),
    output: z.object({ status: z.enum(['ran', 'skipped']), deleted: z.number().int() }),
  }),
});

export const conversationsContract = defineContract({
  orchestra: defineContract(orchestraContractDefinitions),
  workflows: defineContract(workflowContractDefinitions),
  codeWorkflows: defineContract(codeWorkflowContractDefinitions),
  attachments: defineContract({
    prepareLocalFiles: fallible({
      input: z.object({ conversationId: z.string(), sources: localTerminalFilesSchema }),
      data: z.array(preparedTerminalFileSchema),
      error: projectAttachmentErrorUnion(attachmentErrorSchema),
    }),
    upload: uploadFile({
      input: conversationAttachmentsContract.attachments.upload.input,
      maxSize: conversationAttachmentsContract.attachments.upload.maxSize,
      result: conversationAttachmentsContract.attachments.upload.result,
      error: projectAttachmentErrorUnion(conversationAttachmentsContract.attachments.upload.error),
    }),
    download: downloadFile({
      input: attachmentKey,
      meta: conversationAttachmentsContract.attachments.download.meta,
      error: projectAttachmentErrorUnion(
        conversationAttachmentsContract.attachments.download.error
      ),
    }),
    delete: runtimeFallibleProcedure(
      attachmentKey,
      conversationAttachmentsContract.attachments.delete.output
    ),
  }),
  getConversations: procedure({
    input: z.void(),
    output: z.custom<Conversation[]>(),
  }),
  createConversation: fallible({
    input: z.custom<CreateConversationParams>(),
    data: z.custom<Conversation>(),
    error: projectAttachmentErrorSchema,
  }),
  deleteConversation: procedure({
    input: conversationLocation,
    output: z.void(),
  }),
  switchView: fallible({
    input: z.object({
      conversationId: z.string(),
      type: z.enum(['pty', 'acp']),
      stopUnobservedTerminal: z.boolean().optional(),
    }),
    data: z.custom<Conversation>(),
    error: z.object({
      type: z.literal('view-switch-failed'),
      message: z.string(),
      canStopTerminal: z.boolean().optional(),
    }),
  }),
  hydrateConversation: fallible({
    input: conversationLocation.extend({
      initialSize: z.object({ cols: z.number(), rows: z.number() }).optional(),
    }),
    data: z.void(),
    error: projectAttachmentErrorSchema,
  }),
  dehydrateConversation: fallible({
    input: conversationLocation,
    data: z.void(),
    error: projectAttachmentErrorSchema,
  }),
  renameConversation: procedure({
    input: z.object({ conversationId: z.string(), name: z.string() }),
    output: z.void(),
  }),
  getConversationsForTask: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string() }),
    output: z.custom<Conversation[]>(),
  }),
  getConversationsForProject: procedure({
    input: z.object({ projectId: z.string() }),
    output: z.custom<Conversation[]>(),
  }),
  markConversationSeen: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.void(),
  }),
  // Machine-page surface (spec §8): host-scoped registry reads plus link-free management.
  listHostConversations: procedure({
    input: z.object({
      location: z.enum(['local', 'remote']),
      sshConnectionId: z.string().nullable(),
    }),
    output: z.custom<HostConversationRow[]>(),
  }),
  linkConversationToTask: procedure({
    input: z.object({ conversationId: z.string(), projectId: z.string(), taskId: z.string() }),
    output: z.void(),
  }),
  deleteHostConversation: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.void(),
  }),
  listExternalSessions: procedure({
    input: z.object({ limit: z.number().int().positive().max(100).optional() }),
    output: z.custom<ExternalSessionSummary[]>(),
  }),
  readMediaPreview: procedure({
    input: z.object({
      conversationId: z.string().min(1).max(256),
      uri: z.string().min(1).max(2048),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      maxBytes: z.number().int().min(1024).max(MEDIA_PREVIEW_MAX_CHUNK_BYTES).optional(),
    }),
    output: z.object({
      name: z.string(),
      mimeType: z.string(),
      size: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      base64: z.string(),
      eof: z.boolean(),
      /** Host's per-call chunk limit; absent on older hosts (80 MB file / 40 MB offset caps). */
      maxChunkBytes: z.number().int().positive().optional(),
    }),
  }),
  events: eventStream({ key: z.void(), event: z.custom<ConversationEvent>() }),
  acp: conversationsAcpContract,
  handoff: conversationsHandoffContract,
  tui: conversationsTuiContract,
  checkpoints: conversationsCheckpointsContract,
});

export type ConversationsContract = typeof conversationsContract;
