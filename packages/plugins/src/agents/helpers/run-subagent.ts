import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { NormalizedEvent } from '@orkestra/core/runtimes/acp/api';
import { parseSubagentToolOutput } from './subagent-output';

/**
 * Orkestra'nın kendi `run_subagent` MCP aracının adı. Her ajan MCP aracını farklı yazar:
 * `mcp__orkestra-subagents__run_subagent`, `orkestra-subagents/run_subagent`,
 * `orkestra-subagents.run_subagent`, ya da yalnızca `run_subagent`.
 */
const RUN_SUBAGENT_TOOL = /(?:^|__|[:/.])run_subagent$/i;

export function isRunSubagentToolName(name: string | null | undefined): boolean {
  return Boolean(name && RUN_SUBAGENT_TOOL.test(name.trim()));
}

/**
 * `run_subagent` çağrısını (hangi ajan çağırırsa çağırsın) alt ajan olayına çevirir; araç
 * Orkestra'nın kendisinindir, bu yüzden sağlayıcı, model, görev, durum ve sonuç girdi ve çıktıdan
 * okunur. Çağrı `run_subagent` değilse `null` döner.
 */
export function enrichRunSubagentUpdate(
  event: NormalizedEvent,
  raw: SessionUpdate
): NormalizedEvent | null {
  if (event.kind !== 'tool_call' && event.kind !== 'tool_update') return null;
  const rawTitle =
    typeof (raw as { title?: unknown }).title === 'string' ? (raw as { title: string }).title : '';
  const titleMatches =
    (event.kind === 'tool_call' && isRunSubagentToolName(event.title)) ||
    isRunSubagentToolName(rawTitle);
  const parsedOut = parseSubagentToolOutput(
    raw,
    event.kind === 'tool_update' ? event.outputText : undefined
  );
  if (!titleMatches && !(event.kind === 'tool_update' && Boolean(parsedOut?.runId))) return null;

  const rawInput = (
    raw as {
      rawInput?: {
        provider?: unknown;
        model?: unknown;
        effort?: unknown;
        role?: unknown;
        prompt?: unknown;
      };
    }
  ).rawInput;
  const prompt = typeof rawInput?.prompt === 'string' ? rawInput.prompt : undefined;
  const role =
    (typeof rawInput?.role === 'string' && rawInput.role.trim() ? rawInput.role : undefined) ??
    parsedOut?.role;
  const provider =
    (typeof rawInput?.provider === 'string' && rawInput.provider.trim()
      ? rawInput.provider
      : undefined) ?? parsedOut?.provider;
  const model =
    (typeof rawInput?.model === 'string' && rawInput.model.trim() ? rawInput.model : undefined) ??
    parsedOut?.model;
  const effort =
    (typeof rawInput?.effort === 'string' && rawInput.effort.trim()
      ? rawInput.effort
      : undefined) ?? parsedOut?.effort;
  const status = parsedOut?.ok === false ? 'failed' : (event.status ?? null);
  return {
    kind: 'subagent',
    operation: event.kind === 'tool_call' ? 'start' : 'update',
    toolCallId: event.toolCallId,
    title: role || model || (event.kind === 'tool_call' ? 'Alt Ajan' : ''),
    status,
    parentToolCallId: event.parentToolCallId,
    ...(parsedOut?.runId ? { agentId: parsedOut.runId } : {}),
    ...(prompt ? { prompt, inputSummary: prompt.slice(0, 140) } : {}),
    ...(role ? { role } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(parsedOut?.summary ? { summary: parsedOut.summary } : {}),
    ...(parsedOut?.activities ? { activities: parsedOut.activities } : {}),
  };
}

/** `run_subagent` dışındaki olayları olduğu gibi bırakan, tek başına kullanılabilir kanca. */
export function enrichRunSubagentOnly(event: NormalizedEvent, raw: SessionUpdate): NormalizedEvent {
  return enrichRunSubagentUpdate(event, raw) ?? event;
}
