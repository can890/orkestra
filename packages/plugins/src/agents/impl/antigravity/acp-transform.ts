import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type {
  NormalizedEvent,
  NormalizedSubagentActivity,
  NormalizedToolStatus,
} from '@orkestra/core/runtimes/acp/api';

type AntigravitySubagentMeta = {
  kind?: 'subagent' | 'subagent_update';
  title?: string;
  role?: string;
  provider?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  agentId?: string;
  toolCallId?: string;
  outputFile?: string;
  background?: boolean;
  status?: NormalizedToolStatus;
  summary?: string;
  activities?: NormalizedSubagentActivity[];
};

type AntigravityRawMeta = {
  antigravity?: AntigravitySubagentMeta;
};

function antigravityMeta(raw: SessionUpdate): AntigravitySubagentMeta | undefined {
  const meta = (raw as { _meta?: AntigravityRawMeta | null })._meta;
  return meta?.antigravity;
}

function sanitizeActivities(raw: unknown): NormalizedSubagentActivity[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: NormalizedSubagentActivity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.title !== 'string') continue;
    const kind =
      entry.kind === 'thinking' ||
      entry.kind === 'tool' ||
      entry.kind === 'message' ||
      entry.kind === 'error' ||
      entry.kind === 'status'
        ? entry.kind
        : 'status';
    const status =
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
  return result;
}

/**
 * Antigravity-specific enrichment of a baseline `NormalizedEvent`.
 *
 * Promotes `_meta.antigravity` subagent launches (native invoke_subagent,
 * swarm members, and external orkestra-subagents MCP runs) into first-class
 * `subagent` / `subagent_update` events with model, provider, effort, prompt,
 * and live activity timeline data.
 */
export function enrichAntigravityUpdate(
  update: NormalizedEvent,
  raw: SessionUpdate
): NormalizedEvent {
  if (update.kind !== 'tool_call' && update.kind !== 'tool_update') return update;

  const meta = antigravityMeta(raw);
  if (!meta) return update;

  const activities = sanitizeActivities(meta.activities);

  if (meta.kind === 'subagent') {
    const prompt = typeof meta.prompt === 'string' && meta.prompt.trim() ? meta.prompt : undefined;
    const inputSummary = prompt
      ? prompt.replace(/\s+/g, ' ').trim().slice(0, 140)
      : update.inputSummary;
    return {
      kind: 'subagent',
      operation: update.kind === 'tool_call' ? 'start' : 'update',
      toolCallId: update.toolCallId,
      title: meta.title || update.title || 'Alt Ajan',
      status: meta.status ?? update.status ?? 'in_progress',
      parentToolCallId: update.parentToolCallId,
      ...(inputSummary ? { inputSummary } : {}),
      background: meta.background ?? true,
      ...(typeof meta.agentId === 'string' && meta.agentId ? { agentId: meta.agentId } : {}),
      ...(typeof meta.outputFile === 'string' && meta.outputFile
        ? { outputFile: meta.outputFile }
        : {}),
      ...(prompt ? { prompt } : {}),
      ...(typeof meta.role === 'string' && meta.role ? { role: meta.role } : {}),
      ...(typeof meta.provider === 'string' && meta.provider ? { provider: meta.provider } : {}),
      ...(typeof meta.model === 'string' && meta.model ? { model: meta.model } : {}),
      ...(typeof meta.effort === 'string' && meta.effort ? { effort: meta.effort } : {}),
      ...(activities ? { activities } : {}),
    };
  }

  if (meta.kind === 'subagent_update') {
    const status: NormalizedToolStatus = meta.status ?? update.status ?? 'in_progress';
    return {
      kind: 'subagent_update',
      toolCallId: meta.toolCallId || update.toolCallId,
      ...(typeof meta.agentId === 'string' && meta.agentId ? { agentId: meta.agentId } : {}),
      status,
      ...(typeof meta.summary === 'string' ? { summary: meta.summary } : {}),
      ...(typeof meta.outputFile === 'string' && meta.outputFile
        ? { outputFile: meta.outputFile }
        : {}),
      ...(typeof meta.prompt === 'string' && meta.prompt ? { prompt: meta.prompt } : {}),
      ...(typeof meta.role === 'string' && meta.role ? { role: meta.role } : {}),
      ...(typeof meta.provider === 'string' && meta.provider ? { provider: meta.provider } : {}),
      ...(typeof meta.model === 'string' && meta.model ? { model: meta.model } : {}),
      ...(typeof meta.effort === 'string' && meta.effort ? { effort: meta.effort } : {}),
      ...(activities ? { activities } : {}),
    };
  }

  return update;
}
