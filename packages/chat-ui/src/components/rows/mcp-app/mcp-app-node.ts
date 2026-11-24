import type { ChatMcpAppCall } from '@/commands';
import type { ToolNode } from '@/model';

/** Unit payload of an MCP app row, shown directly below its tool call (or tool group). */
export type ChatMcpApp = {
  kind: 'mcp-app';
  /** Row id; also the key of the app's state in the store. */
  id: string;
  call: ChatMcpAppCall;
};

/** A transcript tool call (not a synthetic group). */
type ToolCallNode = Exclude<ToolNode, { kind: 'tool-group' }>;

function appOfCall(node: ToolCallNode): ChatMcpApp | undefined {
  // Only completed calls: a running call may still wait for the user's permission and a failed
  // one has nothing to show. The call stays visible as a normal tool row either way.
  if (node.status !== 'done' || !node.mcpCall) return undefined;
  const { server, tool, input, result } = node.mcpCall;
  return {
    kind: 'mcp-app',
    id: `${node.id}:mcp-app`,
    call: {
      itemId: node.id,
      toolCallId: node.toolCallId,
      server,
      tool,
      ...(input !== undefined ? { input } : {}),
      ...(result !== undefined ? { result } : {}),
    },
  };
}

/**
 * MCP app candidates of a tool node and its nested calls, in transcript order. Whether a call
 * really has an app is only known once the host resolves it; until then the row is empty (zero
 * height), so calls without an app render exactly as before.
 */
export function mcpAppsOfNode(node: ToolNode): ChatMcpApp[] {
  const apps: ChatMcpApp[] = [];
  const visit = (current: ToolNode) => {
    if (current.kind !== 'tool-group') {
      const app = appOfCall(current);
      if (app) apps.push(app);
    }
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return apps;
}
