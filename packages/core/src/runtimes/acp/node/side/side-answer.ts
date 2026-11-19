import type {
  Client,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import type { Result } from '@orkestra/shared';
import { err, isErr, ok, toSerializedError } from '@orkestra/shared';
import { createScope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import { deriveConfigGroups } from '#runtimes/acp/api/reducer/config-derive';
import type { AcpProcessHost } from '#runtimes/acp/api/transport';
import { createAcpAgentConnection } from '#runtimes/acp/node/connection/acp-agent-connection';
import type { AcpAgentApi, AgentPluginHost } from '#services/agent-plugins/api/plugins';

export const SIDE_ANSWER_TIMEOUT_MS = 90_000;

export type SideAnswerError =
  | { type: 'unsupported'; message: string }
  | { type: 'timeout'; message: string }
  | { type: 'aborted'; message: string }
  | { type: 'failed'; message: string };

export interface SideAnswerRequest {
  providerId: string;
  cwd: string;
  env?: Record<string, string>;
  /** The main session's model; applied only when the transient session offers that exact value. */
  model?: string | null;
  prompt: string;
  /** Aborts the run (conversation closed or disposed). */
  signal: AbortSignal;
  /** Receives each streamed text chunk of the answer. */
  onText(text: string): void;
}

export type SideAnswerRunner = (
  request: SideAnswerRequest
) => Promise<Result<void, SideAnswerError>>;

export interface SideAnswerRunnerDeps {
  host: Pick<AcpProcessHost, 'spawn' | 'spawnTerminal'>;
  agentHost: AgentPluginHost;
  logger: Logger;
  timeoutMs?: number;
}

/** Mode ids a provider uses for "look, do not touch"; first match in this order wins. */
const READ_ONLY_MODE_PATTERNS = [/^plan$/i, /read[-_ ]?only/i, /^ask$/i, /plan/i];

export function pickReadOnlyMode(
  modes: ReadonlyArray<{ id: string; name?: string }>
): string | null {
  for (const pattern of READ_ONLY_MODE_PATTERNS) {
    const match = modes.find((mode) => pattern.test(mode.id) || pattern.test(mode.name ?? ''));
    if (match) return match.id;
  }
  return null;
}

/** Rejects when the agent offers a reject option; otherwise cancels. Never selects an allow. */
export function rejectPermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const reject = request.options.find(
    (option: PermissionOption) => option.kind === 'reject_once' || option.kind === 'reject_always'
  );
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/**
 * Builds the runner that answers a side question with a transient, read-only ACP session of the
 * same provider: its own process (spawned through the same plugin launcher as the main session),
 * no MCP servers, every permission request rejected, torn down after the answer, an error, the
 * timeout or an abort. It never touches the main conversation's session or native id.
 */
export function createSideAnswerRunner(deps: SideAnswerRunnerDeps): SideAnswerRunner {
  const timeoutMs = deps.timeoutMs ?? SIDE_ANSWER_TIMEOUT_MS;
  return async (request) => {
    const binding = deps.agentHost.resolveAcp(request.providerId);
    if (!binding) {
      return err({ type: 'unsupported', message: `'${request.providerId}' ACP desteklemiyor.` });
    }
    const scope = createScope({ label: `acp-side-answer:${request.providerId}` });
    const abort = new AbortController();
    let reason: SideAnswerError | null = null;
    const stop = (error: SideAnswerError): void => {
      reason ??= error;
      abort.abort();
    };
    const onParentAbort = (): void => stop({ type: 'aborted', message: 'Yan cevap iptal edildi.' });
    if (request.signal.aborted) onParentAbort();
    request.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(
      () => stop({ type: 'timeout', message: 'Yan cevap zaman aşımına uğradı.' }),
      timeoutMs
    );
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(reason ?? new Error('aborted'));
      if (abort.signal.aborted) fail();
      else abort.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);

    let agent: AcpAgentApi | null = null;
    let sessionId: string | null = null;
    try {
      const spawn = await deps.agentHost.buildAcpSpawn(request.providerId, {
        cwd: request.cwd,
        env: request.env,
      });
      if (!spawn.success) {
        const message = 'message' in spawn.error ? spawn.error.message : spawn.error.type;
        return err({ type: 'failed', message });
      }
      const client: Client = {
        sessionUpdate: async ({ sessionId: id, update }) => {
          if (id !== sessionId || abort.signal.aborted) return;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            request.onText(update.content.text);
          }
        },
        requestPermission: async (params) => rejectPermission(params),
        readTextFile: async () => {
          throw new Error('Yan cevap oturumu dosya okuyamaz.');
        },
        writeTextFile: async () => {
          throw new Error('Yan cevap oturumu dosya yazamaz.');
        },
        createTerminal: async () => {
          throw new Error('Yan cevap oturumu komut çalıştıramaz.');
        },
      };
      const connection = await Promise.race([
        createAcpAgentConnection(
          { host: deps.host, behavior: binding.behavior, logger: deps.logger },
          {
            providerId: request.providerId,
            spawn: spawn.data,
            scope,
            buildClient: () => client,
            onClosed: () =>
              stop({ type: 'failed', message: 'Yan cevap süreci beklenmedik şekilde kapandı.' }),
          }
        ),
        aborted,
      ]);
      if (isErr(connection)) {
        return err({ type: 'failed', message: describe(connection.error) });
      }
      agent = connection.data.agent;
      const session = await Promise.race([
        agent.newSession({ cwd: request.cwd, mcpServers: [] }),
        aborted,
      ]);
      sessionId = session.sessionId;
      await Promise.race([
        configureReadOnly(agent, session, request.model ?? null, deps.logger),
        aborted,
      ]);
      await Promise.race([
        agent.prompt({ sessionId, prompt: [{ type: 'text', text: request.prompt }] }),
        aborted,
      ]);
      return ok(undefined);
    } catch (error) {
      const failure: SideAnswerError = reason ?? {
        type: 'failed',
        message: toSerializedError(error).message,
      };
      if (agent && sessionId && failure.type !== 'failed') {
        await agent.cancel({ sessionId }).catch(() => undefined);
      }
      return err(failure);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onParentAbort);
      if (agent?.closeSession && sessionId) {
        await Promise.race([
          Promise.resolve(agent.closeSession({ sessionId })).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2_000).unref?.()),
        ]);
      }
      await scope.dispose();
    }
  };
}

function describe(error: unknown): string {
  return toSerializedError(error).message || String((error as { type?: string }).type);
}

/** Best effort: a failure here is logged, never fatal, because permissions are rejected anyway. */
async function configureReadOnly(
  agent: AcpAgentApi,
  session: {
    sessionId: string;
    configOptions?: SessionConfigOption[] | null;
    modes?: { availableModes: Array<{ id: string; name: string }> } | null;
  },
  model: string | null,
  logger: Logger
): Promise<void> {
  const groups = deriveConfigGroups(session.configOptions ?? []);
  try {
    if (model && groups.modelOptions?.available.some((option) => option.id === model)) {
      if (groups.modelOptions.selected !== model && agent.setSessionConfigOption) {
        await agent.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: groups.modelOptions.configId,
          value: model,
        });
      }
    }
    const modeId = pickReadOnlyMode(groups.modeOptions?.available ?? []);
    if (modeId && groups.modeOptions && agent.setSessionConfigOption) {
      await agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: groups.modeOptions.configId,
        value: modeId,
      });
      return;
    }
    const legacy = pickReadOnlyMode(session.modes?.availableModes ?? []);
    if (legacy && agent.setSessionMode) {
      await agent.setSessionMode({ sessionId: session.sessionId, modeId: legacy });
    }
  } catch (error) {
    logger.warn('side answer: could not apply model or read-only mode', {
      error: toSerializedError(error),
    });
  }
}
