import { absoluteBasename } from '@orkestra/core/primitives/path/api';
import type { workspaceWireContract } from '@orkestra/core/workspace-server';
import { runWithTimeout, type Clock } from '@orkestra/shared/scheduling';
import type { ContractClient } from '@orkestra/wire/rpc';
import type { ServerActivity, ServerActivityItem } from '../../../api/maintenance-contract';

type WorkspaceClient = ContractClient<typeof workspaceWireContract>;
// Hosts servisi çalışma zamanı API'lerini doğrudan içe aktaramaz (modül sınırları);
// türler workspace-server sözleşmesinin istemci çağrılarından türetilir.
const acpSnapshot = (client: WorkspaceClient) =>
  client.acp.sessions.state(undefined, 'list').snapshot();
const tuiSnapshot = (client: WorkspaceClient) =>
  client.tuiAgents.sessions.state(undefined, 'list').snapshot();
const terminalSnapshot = (client: WorkspaceClient) =>
  client.terminals.sessions.state(undefined, 'list').snapshot();
const devServerSnapshot = (client: WorkspaceClient) =>
  client.scripts.devServers.state(undefined, 'list').snapshot();
const activeRuns = (client: WorkspaceClient) => client.scripts.activeRuns();

type AcpSessionList = Awaited<ReturnType<typeof acpSnapshot>>['data'];
export type TuiSessionList = Awaited<ReturnType<typeof tuiSnapshot>>['data'];
export type TerminalSessionList = Awaited<ReturnType<typeof terminalSnapshot>>['data'];
export type ScriptDevServerList = Awaited<ReturnType<typeof devServerSnapshot>>['data'];
export type SessionSummary = AcpSessionList[string];
export type ScriptActiveRun = Awaited<ReturnType<typeof activeRuns>>[number];

/** `scripts.activeRuns` bu protokol küçük sürümünden itibaren vardır. */
export const SCRIPT_ACTIVE_RUNS_MINOR = 1;

/** Son çıktı/girdi bu süre içindeyse hazır görünen bir ACP oturumu da meşgul sayılır. */
export const DEFAULT_ACTIVITY_QUIET_WINDOW_MS = 5 * 60_000;

const DEFAULT_SOURCE_TIMEOUT_MS = 5_000;

/**
 * Daemon'ın kendi görüşünden etkinlik kaynakları. Her kaynak bağımsız okunur; biri
 * başarısız olursa sonuç `complete: false` olur ve otomatik güncelleme yapılmaz.
 */
export type ServerActivitySources = {
  acpSessions(): Promise<Record<string, SessionSummary>>;
  tuiSessions(): Promise<TuiSessionList>;
  terminals(): Promise<TerminalSessionList>;
  /** Protokol minor >= 1 olan sunucularda tanımlıdır. */
  scriptRuns?: () => Promise<ScriptActiveRun[]>;
  /** Eski sunucularda betik çalıştırmalarının yerine geçen yaklaşık sinyal. */
  scriptDevServers(): Promise<ScriptDevServerList>;
};

export function activitySourcesFromClient(
  client: WorkspaceClient,
  agreedMinor: number
): ServerActivitySources {
  return {
    acpSessions: async () => (await acpSnapshot(client)).data,
    tuiSessions: async () => (await tuiSnapshot(client)).data,
    terminals: async () => (await terminalSnapshot(client)).data,
    scriptRuns: agreedMinor >= SCRIPT_ACTIVE_RUNS_MINOR ? () => activeRuns(client) : undefined,
    scriptDevServers: async () => (await devServerSnapshot(client)).data,
  };
}

export type ReadServerActivityOptions = {
  clock: Clock;
  quietWindowMs?: number;
  sourceTimeoutMs?: number;
};

export async function readServerActivity(
  sources: ServerActivitySources,
  options: ReadServerActivityOptions
): Promise<ServerActivity> {
  const now = options.clock.now();
  const quietWindowMs = options.quietWindowMs ?? DEFAULT_ACTIVITY_QUIET_WINDOW_MS;
  const read = <T>(source: () => Promise<T>) => readSource(source, options);

  const [acp, tui, terminals, scripts] = await Promise.all([
    read(sources.acpSessions),
    read(sources.tuiSessions),
    read(sources.terminals),
    sources.scriptRuns
      ? read(sources.scriptRuns).then((result) =>
          result.ok ? { ok: true as const, items: scriptRunItems(result.value) } : result
        )
      : read(sources.scriptDevServers).then((result) =>
          result.ok ? { ok: true as const, items: devServerItems(result.value) } : result
        ),
  ]);

  const items: ServerActivityItem[] = [];
  if (acp.ok) items.push(...acpItems(acp.value, now, quietWindowMs));
  if (tui.ok) items.push(...tuiItems(tui.value));
  if (terminals.ok) items.push(...terminalItems(terminals.value));
  if (scripts.ok) items.push(...scripts.items);

  return {
    checkedAt: now,
    items,
    complete: acp.ok && tui.ok && terminals.ok && scripts.ok,
  };
}

/** Eksik okuma ya da herhangi bir etkinlik varken sunucu boşta değildir. */
export function isServerIdle(activity: ServerActivity): boolean {
  return activity.complete && activity.items.length === 0;
}

export function acpItems(
  sessions: Record<string, SessionSummary>,
  now: number,
  quietWindowMs: number
): ServerActivityItem[] {
  const items: ServerActivityItem[] = [];
  for (const [id, session] of Object.entries(sessions)) {
    if (session.suspended || session.lifecycle === 'closed') continue;
    const lastIo = Math.max(session.lastInputAt ?? 0, session.lastOutputAt ?? 0);
    const busy =
      session.lifecycle !== 'ready' ||
      session.isGenerating ||
      session.pendingPermissionCount > 0 ||
      session.backgroundAgentCount > 0 ||
      session.queuedPromptCount > 0 ||
      (lastIo > 0 && now - lastIo < quietWindowMs);
    if (!busy) continue;
    items.push({
      kind: 'agent-turn',
      id: session.conversationId || id,
      label: session.title?.trim() || session.providerId,
    });
  }
  return items;
}

/** TUI ajanları etkileşimli süreçlerdir; çalışan her oturum yeniden başlatmada kesilir. */
export function tuiItems(sessions: TuiSessionList): ServerActivityItem[] {
  return Object.entries(sessions)
    .filter(([, session]) => session.status === 'starting' || session.status === 'running')
    .map(([id, session]) => ({
      kind: 'agent-session' as const,
      id: session.conversationId || id,
      label: session.title?.trim() || session.providerId || 'TUI agent',
    }));
}

/** tmux terminalleri daemon yeniden başlasa da tmux sunucusunda yaşamaya devam eder. */
export function terminalItems(sessions: TerminalSessionList): ServerActivityItem[] {
  return Object.entries(sessions)
    .filter(([, session]) => session.status === 'running' && session.tmux !== true)
    .map(([id, session]) => ({
      kind: 'terminal' as const,
      id: session.key.id || id,
      label: absoluteBasename(session.key.workspace.path) || session.key.id,
    }));
}

function scriptRunItems(runs: readonly ScriptActiveRun[]): ServerActivityItem[] {
  return runs.map((run) => ({
    kind: 'script' as const,
    id: run.runId,
    label: `${run.script} · ${lastPathSegment(run.workspacePath)}`,
  }));
}

function devServerItems(servers: ScriptDevServerList): ServerActivityItem[] {
  return Object.entries(servers).map(([id, server]) => ({
    kind: 'dev-server' as const,
    id,
    label: `${server.key.script} · ${lastPathSegment(server.key.workspacePath)} :${server.port}`,
  }));
}

function lastPathSegment(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  const segment = trimmed.split(/[\\/]/).pop();
  return segment || value;
}

type SourceResult<T> = { ok: true; value: T } | { ok: false };

async function readSource<T>(
  source: () => Promise<T>,
  options: ReadServerActivityOptions
): Promise<SourceResult<T>> {
  try {
    const value = await runWithTimeout(() => source(), {
      timeoutMs: options.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS,
      clock: options.clock,
    });
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}
