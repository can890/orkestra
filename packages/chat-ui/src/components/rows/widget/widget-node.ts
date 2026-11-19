import {
  isWidgetMcpCall,
  isWidgetToolName,
  validateWidgetInput,
} from '@orkestra/core/runtimes/acp/api/client';
import type { ToolNode } from '@/model';

/** Unit payload of a widget row. Exactly one of `html` and `svg` is set. */
export type ChatWidget = {
  kind: 'widget';
  id: string;
  title: string;
  html?: string;
  svg?: string;
};

/** A transcript tool call (not a synthetic group). */
type ToolCallNode = Exclude<ToolNode, { kind: 'tool-group' }>;

function isWidgetCall(node: ToolCallNode): boolean {
  switch (node.kind) {
    case 'mcp-tool-call':
      return isWidgetMcpCall(node) || isWidgetToolName(node.title);
    case 'unknown-tool-call':
      return isWidgetToolName(node.name) || isWidgetToolName(node.title);
    default:
      return isWidgetToolName(node.title);
  }
}

/**
 * The widget a `show_widget` tool call draws, or undefined. The widget comes from the call's own
 * input kept on the transcript node, so history reloads redraw it without extra storage. It is
 * validated again here: the node may come from persisted or replayed data. Only a completed call
 * is drawn: a running one may still be waiting for the user's permission, and a failed one is
 * shown as a normal tool row.
 */
export function widgetOfNode(node: ToolNode): ChatWidget | undefined {
  if (node.kind === 'tool-group' || node.status !== 'done') return undefined;
  if (!node.widget || !isWidgetCall(node)) return undefined;
  const checked = validateWidgetInput(node.widget);
  if (!checked.success) return undefined;
  const { title, html, svg } = checked.data;
  return {
    kind: 'widget',
    id: node.id,
    title,
    ...(html !== undefined ? { html } : {}),
    ...(svg !== undefined ? { svg } : {}),
  };
}

export function isWidgetNode(node: ToolNode): boolean {
  return widgetOfNode(node) !== undefined;
}
