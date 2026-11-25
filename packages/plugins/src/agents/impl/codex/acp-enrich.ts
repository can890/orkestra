import type { EnrichHook } from '@orkestra/core/runtimes/acp/api';
import { enrichRunSubagentUpdate } from '../../helpers/run-subagent';
import { enrichCodexCollaboration } from './collaboration';

/** codex-acp represents startup diagnostics as synthetic failed tool calls. */
export const enrichCodexUpdate: EnrichHook = (event, raw) => {
  const runSubagent = enrichRunSubagentUpdate(event, raw);
  if (runSubagent) return runSubagent;

  const collaboration = enrichCodexCollaboration(event, raw);
  if (collaboration) return collaboration;

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
