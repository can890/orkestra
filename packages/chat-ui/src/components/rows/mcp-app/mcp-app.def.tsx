import { defineUnit } from '@core/units';
import type { ChatMcpApp } from './mcp-app-node';
import { mcpAppRowHeight } from './mcp-app-store';
import { McpApp } from './McpApp';

/**
 * MCP app row below a tool call. Until the host resolves an app the row is zero high, so a call
 * without an app looks as before; the bottom margin matches plain tool rows so the seam to the
 * next row keeps its usual gap.
 */
export const mcpAppUnitDef = defineUnit<ChatMcpApp, Record<string, never>>({
  kind: 'mcp-app',
  margin: { top: 0, bottom: 2 },
  vars: {},
  estimate: (data) => mcpAppRowHeight(data.id),
  measure: (data) => mcpAppRowHeight(data.id),
  Render: (props) => <McpApp data={props.data} />,
});
