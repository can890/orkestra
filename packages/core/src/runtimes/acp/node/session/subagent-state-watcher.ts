import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Result } from '@orkestra/shared';
import { ok, toSerializedError } from '@orkestra/shared';
import type {
  AcpCancelTurnError,
  NormalizedEvent,
  NormalizedSubagentActivity,
  NormalizedToolStatus,
} from '#runtimes/acp/api';
import { acpErr } from '#runtimes/acp/api';

const STRICT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const CANCELLED_SUMMARY = 'Alt ajan kullanıcı tarafından durduruldu.';
const DEFAULT_POLL_INTERVAL_MS = 400;
const PROMPT_MATCH_WINDOW_MS = 8000;
const SIGKILL_GRACE_MS = 1500;

export function resolveDefaultSubagentsDir(): string {
  return (
    process.env.ORKESTRA_SUBAGENTS_DIR ||
    join(homedir(), '.local', 'state', 'orkestra', 'subagents')
  );
}

export const DEFAULT_SUBAGENTS_DIR = resolveDefaultSubagentsDir();

export type SubagentUpdateEvent = Extract<NormalizedEvent, { kind: 'subagent_update' }>;
export type SubagentStartEvent = Extract<NormalizedEvent, { kind: 'subagent' }>;

interface SubagentRunFile {
  runId?: unknown;
  pid?: unknown;
  status?: unknown;
  cancelled?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  updatedAt?: unknown;
  summary?: unknown;
  prompt?: unknown;
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  effort?: unknown;
  activities?: unknown;
  [key: string]: unknown;
}

interface TrackedSubagent {
  toolCallId: string;
  agentId?: string;
  prompt?: string;
  role?: string;
  title?: string;
  startedAt: number;
  matchedRunId: string | null;
  lastSerialized: string;
}

export interface SubagentStateWatcherOptions {
  stateDir?: string;
  intervalMs?: number;
  onUpdate: (event: SubagentUpdateEvent) => void;
}

const activeWatchers = new Set<SubagentStateWatcher>();

function sanitizeActivities(raw: unknown): NormalizedSubagentActivity[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: NormalizedSubagentActivity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.title !== 'string') continue;
    const kind: NormalizedSubagentActivity['kind'] =
      entry.kind === 'thinking' ||
      entry.kind === 'tool' ||
      entry.kind === 'message' ||
      entry.kind === 'error' ||
      entry.kind === 'status'
        ? entry.kind
        : 'status';
    const status: NormalizedSubagentActivity['status'] =
      entry.status === 'running' || entry.status === 'done' || entry.status === 'error'
        ? entry.status
        : undefined;
    result.push({
      id: entry.id,
      kind,
      title: entry.title,
      ...(typeof entry.detail === 'string' && entry.detail ? { detail: entry.detail } : {}),
      ...(status ? { status } : {}),
      ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
    });
  }
  return result.length > 0 ? result : undefined;
}

function normalizeStatus(raw: unknown): NormalizedToolStatus {
  if (raw === 'completed' || raw === 'failed') return raw;
  return 'in_progress';
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function serializeComparable(payload: {
  status: NormalizedToolStatus;
  summary?: string;
  provider?: string;
  model?: string;
  effort?: string;
  activities?: NormalizedSubagentActivity[];
}): string {
  return JSON.stringify({
    status: payload.status,
    ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
    ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
    ...(payload.activities !== undefined ? { activities: payload.activities } : {}),
  });
}

async function readRunFile(filePath: string): Promise<SubagentRunFile | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SubagentRunFile;
  } catch {
    return null;
  }
}

export class SubagentStateWatcher {
  readonly stateDir: string;
  private readonly intervalMs: number;
  private readonly onUpdate: (event: SubagentUpdateEvent) => void;
  private readonly entries = new Map<string, TrackedSubagent>();
  private readonly claimedRunIds = new Set<string>();
  private readonly seenByRunId = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollingPromise: Promise<void> | null = null;
  private repollRequested = false;
  private disposed = false;

  constructor(options: SubagentStateWatcherOptions) {
    this.stateDir = options.stateDir ?? resolveDefaultSubagentsDir();
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onUpdate = options.onUpdate;
  }

  get activeCount(): number {
    return this.entries.size;
  }

  register(event: SubagentStartEvent, now = Date.now()): void {
    if (this.disposed) return;
    if (event.operation === 'update') return;
    if (event.status === 'completed' || event.status === 'failed') return;

    const existing = this.entries.get(event.toolCallId);
    if (existing) {
      if (event.agentId && !existing.agentId) existing.agentId = event.agentId;
      if (event.prompt?.trim() && !existing.prompt) existing.prompt = event.prompt.trim();
      if (event.role && !existing.role) existing.role = event.role;
      if (event.title && !existing.title) existing.title = event.title;
      if (!existing.matchedRunId && event.agentId && STRICT_UUID_RE.test(event.agentId)) {
        existing.matchedRunId = event.agentId;
        this.claimedRunIds.add(event.agentId);
      }
      return;
    }

    const matchedRunId = event.agentId && STRICT_UUID_RE.test(event.agentId) ? event.agentId : null;
    if (matchedRunId) {
      this.claimedRunIds.add(matchedRunId);
    }
    this.entries.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.prompt?.trim() ? { prompt: event.prompt.trim() } : {}),
      ...(event.role ? { role: event.role } : {}),
      ...(event.title ? { title: event.title } : {}),
      startedAt: now,
      matchedRunId,
      lastSerialized: '',
    });

    activeWatchers.add(this);
    this.ensureTimer();
    void this.poll();
  }

  observeEvent(event: SubagentStartEvent | SubagentUpdateEvent): void {
    if (this.disposed) return;
    const isUpdate = event.kind === 'subagent_update' || event.operation === 'update';
    const isTerminal = event.status === 'completed' || event.status === 'failed';
    if (!isUpdate && !isTerminal) return;

    const status = normalizeStatus(event.status);
    const summary = optionalNonEmptyString(event.summary);
    const provider = optionalNonEmptyString(event.provider);
    const model = optionalNonEmptyString(event.model);
    const effort = optionalNonEmptyString(event.effort);
    const activities = sanitizeActivities(event.activities);
    const serialized = serializeComparable({
      status,
      summary,
      provider,
      model,
      effort,
      activities,
    });

    const uuidAgentId = event.agentId && STRICT_UUID_RE.test(event.agentId) ? event.agentId : null;
    if (uuidAgentId) {
      this.seenByRunId.set(uuidAgentId, serialized);
      this.claimedRunIds.add(uuidAgentId);
    }

    const target = event.toolCallId
      ? this.entries.get(event.toolCallId)
      : uuidAgentId
        ? [...this.entries.values()].find(
            (entry) => entry.matchedRunId === uuidAgentId || entry.agentId === uuidAgentId
          )
        : undefined;

    if (target) {
      if (uuidAgentId && !target.matchedRunId) {
        target.matchedRunId = uuidAgentId;
      }
      target.lastSerialized = serialized;
      if (isTerminal) {
        this.entries.delete(target.toolCallId);
        this.stopTimerIfEmpty();
      }
    }
  }

  async poll(): Promise<void> {
    if (this.disposed || this.entries.size === 0) return;
    if (this.pollingPromise) {
      this.repollRequested = true;
      await this.pollingPromise;
      return;
    }

    const run = async (): Promise<void> => {
      do {
        this.repollRequested = false;
        await this.pollOnce();
      } while (this.repollRequested && !this.disposed && this.entries.size > 0);
    };

    this.pollingPromise = run().finally(() => {
      this.pollingPromise = null;
    });
    await this.pollingPromise;
  }

  async notifyRunUpdated(runId: string): Promise<void> {
    if (this.disposed || this.entries.size === 0) return;
    if (this.pollingPromise) {
      this.repollRequested = true;
      await this.pollingPromise;
      return;
    }
    const hasRelevantEntry = [...this.entries.values()].some(
      (entry) => entry.matchedRunId === runId || entry.agentId === runId || !entry.matchedRunId
    );
    if (hasRelevantEntry) {
      await this.poll();
    }
  }

  clear(): void {
    this.entries.clear();
    this.claimedRunIds.clear();
    this.seenByRunId.clear();
    this.repollRequested = false;
    this.stopTimer();
    activeWatchers.delete(this);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private ensureTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private stopTimerIfEmpty(): void {
    if (this.entries.size === 0) {
      this.stopTimer();
      activeWatchers.delete(this);
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed || this.entries.size === 0) return;

    const fileCache = new Map<string, SubagentRunFile | null>();
    let dirRunFiles: Array<{ runId: string; data: SubagentRunFile }> | null = null;

    const readCachedRunFile = async (runId: string): Promise<SubagentRunFile | null> => {
      if (!SAFE_FILE_ID_RE.test(runId)) return null;
      if (fileCache.has(runId)) return fileCache.get(runId) ?? null;
      const data = await readRunFile(join(this.stateDir, `${runId}.json`));
      fileCache.set(runId, data);
      return data;
    };

    const loadDirRunFiles = async (): Promise<Array<{ runId: string; data: SubagentRunFile }>> => {
      if (dirRunFiles !== null) return dirRunFiles;
      dirRunFiles = [];
      let entries: string[];
      try {
        entries = await readdir(this.stateDir);
      } catch {
        return dirRunFiles;
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const base = name.slice(0, -'.json'.length);
        if (!SAFE_FILE_ID_RE.test(base)) continue;
        const data = await readCachedRunFile(base);
        if (!data) continue;
        const runId =
          typeof data.runId === 'string' && data.runId.trim() ? data.runId.trim() : base;
        dirRunFiles.push({ runId, data });
      }
      return dirRunFiles;
    };

    for (const entry of [...this.entries.values()]) {
      if (this.disposed) return;

      let matchedData: SubagentRunFile | null = null;

      if (entry.matchedRunId) {
        matchedData = await readCachedRunFile(entry.matchedRunId);
      } else {
        if (entry.agentId && SAFE_FILE_ID_RE.test(entry.agentId)) {
          const direct = await readCachedRunFile(entry.agentId);
          if (direct) {
            const resolvedId =
              typeof direct.runId === 'string' && direct.runId.trim()
                ? direct.runId.trim()
                : entry.agentId;
            if (!this.claimedRunIds.has(resolvedId)) {
              entry.matchedRunId = resolvedId;
              this.claimedRunIds.add(resolvedId);
              matchedData = direct;
            }
          }
        }

        if (
          !matchedData &&
          entry.prompt &&
          (!entry.agentId || !STRICT_UUID_RE.test(entry.agentId))
        ) {
          const candidates = await loadDirRunFiles();
          let bestRunId: string | null = null;
          let bestData: SubagentRunFile | null = null;
          let bestStarted = -Infinity;

          for (const candidate of candidates) {
            if (this.claimedRunIds.has(candidate.runId)) continue;
            const startedAt = candidate.data.startedAt;
            if (
              typeof startedAt !== 'number' ||
              startedAt < entry.startedAt - PROMPT_MATCH_WINDOW_MS
            ) {
              continue;
            }
            const candidatePrompt =
              typeof candidate.data.prompt === 'string' ? candidate.data.prompt.trim() : '';
            if (candidatePrompt !== entry.prompt) continue;
            if (startedAt >= bestStarted) {
              bestStarted = startedAt;
              bestRunId = candidate.runId;
              bestData = candidate.data;
            }
          }

          if (bestRunId && bestData) {
            entry.matchedRunId = bestRunId;
            this.claimedRunIds.add(bestRunId);
            matchedData = bestData;
          }
        }
      }

      if (!matchedData || !entry.matchedRunId) continue;

      const status = normalizeStatus(matchedData.status);
      const summary = optionalNonEmptyString(matchedData.summary);
      const provider = optionalNonEmptyString(matchedData.provider);
      const model = optionalNonEmptyString(matchedData.model);
      const effort = optionalNonEmptyString(matchedData.effort);
      const role = optionalNonEmptyString(matchedData.role);
      const prompt = optionalNonEmptyString(matchedData.prompt) ?? entry.prompt;
      const activities = sanitizeActivities(matchedData.activities);

      const serialized = serializeComparable({
        status,
        summary,
        provider,
        model,
        effort,
        activities,
      });

      const alreadySeen =
        serialized === entry.lastSerialized ||
        this.seenByRunId.get(entry.matchedRunId) === serialized;

      if (!alreadySeen) {
        entry.lastSerialized = serialized;
        this.seenByRunId.set(entry.matchedRunId, serialized);
        this.onUpdate({
          kind: 'subagent_update',
          toolCallId: entry.toolCallId,
          agentId: entry.matchedRunId,
          status,
          ...(summary !== undefined ? { summary } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(activities !== undefined ? { activities } : {}),
        });
      }

      if (status === 'completed' || status === 'failed') {
        this.entries.delete(entry.toolCallId);
      }
    }

    this.stopTimerIfEmpty();
  }
}

export async function cancelSubagentRun(
  runId: string,
  stateDir: string = resolveDefaultSubagentsDir()
): Promise<Result<{ cancelled: boolean }, AcpCancelTurnError>> {
  if (typeof runId !== 'string' || !STRICT_UUID_RE.test(runId)) {
    return acpErr.invalidState('Geçersiz alt ajan kimliği.');
  }

  const filePath = join(stateDir, `${runId}.json`);
  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return ok({ cancelled: false });
    }
    return acpErr.cancelFailed(toSerializedError(error));
  }

  let data: SubagentRunFile;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return acpErr.cancelFailed({
        name: 'SyntaxError',
        message: 'Alt ajan durum dosyası geçersiz JSON içeriyor.',
      });
    }
    data = parsed as SubagentRunFile;
  } catch (error) {
    return acpErr.cancelFailed(toSerializedError(error));
  }

  if (data.status === 'completed' || data.status === 'failed') {
    return ok({ cancelled: false });
  }

  const pid = data.pid;
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
      const killTimer = setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Process already exited. */
        }
      }, SIGKILL_GRACE_MS);
      killTimer.unref();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ESRCH') {
        return acpErr.cancelFailed(toSerializedError(error));
      }
    }
  }

  const now = Date.now();
  const nextState: SubagentRunFile = {
    ...data,
    status: 'failed',
    cancelled: true,
    completedAt: now,
    updatedAt: now,
    summary: CANCELLED_SUMMARY,
  };

  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(nextState), { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    return acpErr.cancelFailed(toSerializedError(error));
  }

  const targetDir = resolve(stateDir);
  const matchingWatchers = [...activeWatchers].filter(
    (watcher) => resolve(watcher.stateDir) === targetDir
  );
  await Promise.all(matchingWatchers.map((watcher) => watcher.notifyRunUpdated(runId)));

  return ok({ cancelled: true });
}
