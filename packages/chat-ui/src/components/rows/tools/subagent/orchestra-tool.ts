/**
 * orchestra-tool — recognizes calls to the Orkestra conductor's MCP tools.
 *
 * The conductor's tools are served by the `orkestra` MCP server, but every provider spells an MCP
 * tool call differently and gives it a different ACP tool kind:
 *
 *   Claude Code   `mcp__orkestra__spawn_agent`   unknown-tool-call
 *   Codex         `mcp.orkestra.spawn_agent`     execute-tool-call (title `mcp.<server>.<tool>`)
 *   tolerated     `orkestra__spawn_agent`, `orkestra.spawn_agent`, `orkestra:spawn_agent`
 *
 * Detection therefore keys on the server + tool name and ignores the tool kind. The desktop's
 * sub-agent activity (`subagent-activity.ts`) applies the same rule to link workers.
 */

import type { ToolNode } from '@/model';

/** MCP server name the Orkestra conductor tools are registered under. */
const ORCHESTRA_MCP_SERVER = 'orkestra';

/** Conductor tool that starts a worker; workers are sub-agents in their own conversations. */
const ORCHESTRA_SPAWN_TOOL = 'spawn_agent';

/** Optional `mcp` prefix, the `orkestra` server, then the tool, joined by `__`, `.` or `:`. */
const ORCHESTRA_TOOL_NAME = /^(?:mcp(?:__|\.|:))?orkestra(?:__|\.|:)(\w+)$/;

const BARE_TOOL_NAME = /^\w+$/;

/** A transcript tool call (not a synthetic group). */
export type OrchestraToolCallNode = Exclude<ToolNode, { kind: 'tool-group' }>;

/** Bare Orkestra tool name (`spawn_agent`) for a provider tool name or title, if it is one. */
export function orchestraToolName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  return ORCHESTRA_TOOL_NAME.exec(name.trim())?.[1];
}

/**
 * The Orkestra tool a transcript node calls, whatever kind the provider gave it. Synthetic groups
 * and provider-native sub-agents are never Orkestra calls.
 */
export function orchestraToolOf(node: ToolNode): string | undefined {
  switch (node.kind) {
    case 'tool-group':
    case 'spawn-subagent-tool-call':
      return undefined;
    case 'mcp-tool-call': {
      if (node.server === undefined) {
        return orchestraToolName(node.tool) ?? orchestraToolName(node.title);
      }
      if (node.server !== ORCHESTRA_MCP_SERVER) return undefined;
      const tool = node.tool.trim();
      return orchestraToolName(tool) ?? (BARE_TOOL_NAME.test(tool) ? tool : undefined);
    }
    case 'unknown-tool-call':
      return orchestraToolName(node.name) ?? orchestraToolName(node.title);
    default:
      return orchestraToolName(node.title);
  }
}

/**
 * True for the conductor's worker launch call (`spawn_agent`), for any provider. A plain boolean,
 * not a type guard: a guard would narrow the negative branch to `tool-group`.
 */
export function isOrchestraSpawnNode(node: ToolNode): boolean {
  return orchestraToolOf(node) === ORCHESTRA_SPAWN_TOOL;
}
