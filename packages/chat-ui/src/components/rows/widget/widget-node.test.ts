import { describe, expect, it } from 'vitest';
import type { ToolNode } from '@/model';
import { isWidgetNode, widgetOfNode } from './widget-node';

const widget = { title: 'Grafik', html: '<p>merhaba</p>' };
const base = { seq: 0, status: 'done' as const, toolCallId: 'call-1' };

const claude: ToolNode = {
  ...base,
  kind: 'unknown-tool-call',
  id: 'claude',
  title: 'mcp__orkestra-widgets__show_widget',
  name: 'mcp__orkestra-widgets__show_widget',
  toolKind: 'other',
  widget,
};
const codex: ToolNode = {
  ...base,
  kind: 'execute-tool-call',
  id: 'codex',
  title: 'mcp.orkestra-widgets.show_widget',
  command: 'mcp.orkestra-widgets.show_widget',
  widget: { title: 'Daire', svg: '<svg/>' },
};

describe('widgetOfNode', () => {
  it('draws the widget kept on the tool call, for any provider spelling', () => {
    expect(widgetOfNode(claude)).toEqual({ kind: 'widget', id: 'claude', ...widget });
    expect(widgetOfNode(codex)).toEqual({
      kind: 'widget',
      id: 'codex',
      title: 'Daire',
      svg: '<svg/>',
    });
    expect(
      isWidgetNode({
        ...base,
        kind: 'mcp-tool-call',
        id: 'mcp',
        title: 'show_widget',
        server: 'orkestra-widgets',
        tool: 'show_widget',
        widget,
      })
    ).toBe(true);
  });

  it('shows failed calls and calls without a stored input as plain tool rows', () => {
    expect(widgetOfNode({ ...claude, status: 'error' } as ToolNode)).toBeUndefined();
    const { widget: _ignored, ...withoutInput } = claude as ToolNode & { widget?: unknown };
    expect(widgetOfNode(withoutInput as ToolNode)).toBeUndefined();
  });

  it('ignores other tools even when they carry a widget-shaped input', () => {
    expect(
      widgetOfNode({
        ...claude,
        title: 'mcp__other__render',
        name: 'mcp__other__render',
      } as ToolNode)
    ).toBeUndefined();
  });

  it('re-validates replayed input', () => {
    expect(
      widgetOfNode({ ...claude, widget: { title: 'x', html: '<p/>', svg: '<svg/>' } } as ToolNode)
    ).toBeUndefined();
    expect(widgetOfNode({ ...claude, widget: { title: 'x' } } as ToolNode)).toBeUndefined();
  });

  it('never treats groups as widgets', () => {
    expect(
      widgetOfNode({
        kind: 'tool-group',
        id: 'g',
        seq: 0,
        label: 'Tools',
        groupKind: 'tool-run',
        status: 'done',
        children: [claude],
      })
    ).toBeUndefined();
  });
});
