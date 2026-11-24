import type { EnrichHook } from '@orkestra/core/runtimes/acp/api';
import { parseSubagentToolOutput } from '../../helpers/subagent-output';

/** codex-acp represents startup diagnostics as synthetic failed tool calls. */
export const enrichCodexUpdate: EnrichHook = (event, raw) => {
  const isTool = event.kind === 'tool_call' || event.kind === 'tool_update';
  const rawTitle = typeof (raw as { title?: unknown }).title === 'string' ? (raw as { title: string }).title : '';
  const titleMatches =
    (event.kind === 'tool_call' && /(?:^|__|[:/])run_subagent$/i.test(event.title)) ||
    /(?:^|__|[:/])run_subagent$/i.test(rawTitle);
  const parsedOut = isTool
    ? parseSubagentToolOutput(raw, event.kind === 'tool_update' ? event.outputText : undefined)
    : null;

  if (isTool && (titleMatches || (event.kind === 'tool_update' && Boolean(parsedOut?.runId)))) {
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

  if (
    event.kind !== 'tool_call' ||
    event.status !== 'failed' ||
    event.toolKind !== 'other' ||
    event.parentToolCallId !== null ||
    !event.toolCallId.startsWith('mcp_startup.')
  )
    return event;

  let server: string;
  try {
    server = decodeURIComponent(event.toolCallId.slice('mcp_startup.'.length));
  } catch {
    return event;
  }
  if (!server || event.title !== `mcp__${server}__startup`) return event;
  const error =
    raw.sessionUpdate === 'tool_call'
      ? raw.content
          ?.flatMap((entry) =>
            entry.type === 'content' && entry.content.type === 'text' ? [entry.content.text] : []
          )
          .join('\n')
      : undefined;
  return {
    kind: 'mcp_startup_failure',
    server,
    error: error || 'MCP server failed to start.',
  };
};
