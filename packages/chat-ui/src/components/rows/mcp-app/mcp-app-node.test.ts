import { describe, expect, it } from 'vitest';
import type { ToolNode } from '@/model';
import { mcpAppsOfNode } from './mcp-app-node';
import { colorSchemeOf, mcpAppStyleVariables } from './mcp-app-theme';

const plainTool = (id: string): ToolNode => ({
  kind: 'unknown-tool-call',
  id,
  seq: 0,
  toolCallId: `call-${id}`,
  title: 'Bash',
  status: 'done',
  toolKind: 'other',
  name: 'Bash',
});

const mcpTool = (id: string, status: 'done' | 'running' | 'error' = 'done'): ToolNode => ({
  kind: 'unknown-tool-call',
  id,
  seq: 0,
  toolCallId: `call-${id}`,
  title: 'mcp__weather__forecast',
  status,
  toolKind: 'other',
  name: 'mcp__weather__forecast',
  mcpCall: {
    server: 'weather',
    tool: 'forecast',
    input: { city: 'Oslo' },
    result: { content: [{ type: 'text', text: 'Sunny' }] },
  },
});

describe('mcpAppsOfNode', () => {
  it('maps a completed MCP call to an app candidate', () => {
    expect(mcpAppsOfNode(mcpTool('a'))).toEqual([
      {
        kind: 'mcp-app',
        id: 'a:mcp-app',
        call: {
          itemId: 'a',
          toolCallId: 'call-a',
          server: 'weather',
          tool: 'forecast',
          input: { city: 'Oslo' },
          result: { content: [{ type: 'text', text: 'Sunny' }] },
        },
      },
    ]);
  });

  it('skips running, failed and non-MCP calls', () => {
    expect(mcpAppsOfNode(mcpTool('a', 'running'))).toEqual([]);
    expect(mcpAppsOfNode(mcpTool('a', 'error'))).toEqual([]);
    expect(mcpAppsOfNode(plainTool('b'))).toEqual([]);
  });

  it('collects nested calls inside tool groups', () => {
    const group: ToolNode = {
      kind: 'tool-group',
      id: 'g',
      seq: 0,
      label: 'Used 2 tools',
      groupKind: 'tool-run',
      status: 'done',
      children: [mcpTool('a'), plainTool('b'), mcpTool('c')],
    } as ToolNode;
    expect(mcpAppsOfNode(group).map((app) => app.id)).toEqual(['a:mcp-app', 'c:mcp-app']);
  });
});

describe('MCP app theme', () => {
  it('passes only colour values to the app', () => {
    expect(
      mcpAppStyleVariables({
        bg: 'rgb(17, 17, 17)',
        fg: 'red; background: url(x)',
        border: '#373636',
      })
    ).toEqual({
      '--color-background-primary': 'rgb(17, 17, 17)',
      '--color-border-primary': '#373636',
    });
  });

  it('derives the colour scheme from the background', () => {
    expect(colorSchemeOf('rgb(17, 17, 17)')).toBe('dark');
    expect(colorSchemeOf('rgb(252, 252, 252)')).toBe('light');
    expect(colorSchemeOf(undefined)).toBe('dark');
  });
});
