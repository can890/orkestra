import type { NormalizedSubagentActivity } from '@orkestra/core/runtimes/acp/api';

const MAX_SUBAGENT_SUMMARY_CHARS = 16000;
const MAX_SUBAGENT_ERROR_CHARS = 8000;

export type ParsedSubagentOutput = {
  ok?: boolean;
  runId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  role?: string;
  response?: string;
  error?: string;
  summary?: string;
  activities?: NormalizedSubagentActivity[];
};

function capText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

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

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractTextCandidates(value: unknown, parts: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) parts.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) extractTextCandidates(item, parts);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === 'string' && obj.text.trim()) {
    parts.push(obj.text);
  }
  if (obj.content !== undefined) {
    extractTextCandidates(obj.content, parts);
  }
  if (typeof obj.result === 'string' && obj.result.trim()) {
    parts.push(obj.result);
  }
}

function fromStructuredObject(obj: Record<string, unknown>): ParsedSubagentOutput | null {
  const hasKnownField =
    typeof obj.ok === 'boolean' ||
    typeof obj.runId === 'string' ||
    typeof obj.response === 'string' ||
    typeof obj.error === 'string' ||
    typeof obj.summary === 'string';
  if (!hasKnownField) return null;

  const ok = typeof obj.ok === 'boolean' ? obj.ok : undefined;
  const runId = typeof obj.runId === 'string' && obj.runId.trim() ? obj.runId.trim() : undefined;
  const provider =
    typeof obj.provider === 'string' && obj.provider.trim() ? obj.provider.trim() : undefined;
  const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : undefined;
  const effort =
    typeof obj.effort === 'string' && obj.effort.trim() ? obj.effort.trim() : undefined;
  const role = typeof obj.role === 'string' && obj.role.trim() ? obj.role.trim() : undefined;
  const response =
    typeof obj.response === 'string' && obj.response.trim() ? obj.response.trim() : undefined;
  const error = typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : undefined;
  const rawSummary =
    typeof obj.summary === 'string' && obj.summary.trim() ? obj.summary.trim() : undefined;
  const activities = sanitizeActivities(obj.activities);

  const summary =
    ok === false
      ? capText(error || response || rawSummary || 'Alt ajan hata verdi.', MAX_SUBAGENT_ERROR_CHARS)
      : response
        ? capText(response, MAX_SUBAGENT_SUMMARY_CHARS)
        : rawSummary
          ? capText(rawSummary, MAX_SUBAGENT_SUMMARY_CHARS)
          : error
            ? capText(error, MAX_SUBAGENT_ERROR_CHARS)
            : undefined;

  return {
    ...(ok !== undefined ? { ok } : {}),
    ...(runId ? { runId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(role ? { role } : {}),
    ...(response ? { response } : {}),
    ...(error ? { error } : {}),
    ...(summary ? { summary } : {}),
    ...(activities ? { activities } : {}),
  };
}

/**
 * Extracts structured subagent result metadata, full response text, and activity trace
 * from ACP `tool_call_update` payloads produced by `run_subagent` across Claude, Codex,
 * and Antigravity hosts.
 */
export function parseSubagentToolOutput(
  raw: unknown,
  outputText?: string
): ParsedSubagentOutput | null {
  const candidates: string[] = [];
  const rawObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;

  if (rawObj?.rawOutput !== undefined) {
    if (
      rawObj.rawOutput &&
      typeof rawObj.rawOutput === 'object' &&
      !Array.isArray(rawObj.rawOutput)
    ) {
      const direct = fromStructuredObject(rawObj.rawOutput as Record<string, unknown>);
      if (direct) return direct;
    }
    extractTextCandidates(rawObj.rawOutput, candidates);
  }
  if (rawObj?.content !== undefined) {
    extractTextCandidates(rawObj.content, candidates);
  }
  if (typeof outputText === 'string' && outputText.trim()) {
    candidates.push(outputText);
  }

  for (const text of candidates) {
    const jsonObj = parseJsonObject(text);
    if (jsonObj) {
      const structured = fromStructuredObject(jsonObj);
      if (structured) return structured;
    }
  }

  const status = rawObj?.status;
  if (status === 'completed' || status === 'failed') {
    const plain = candidates.find((text) => text.trim().length > 0);
    if (plain) {
      return {
        ok: status === 'completed',
        summary: capText(
          plain,
          status === 'failed' ? MAX_SUBAGENT_ERROR_CHARS : MAX_SUBAGENT_SUMMARY_CHARS
        ),
      };
    }
  }

  return null;
}
