import type { SegmentCtx } from '@core/units';
import { describe, expect, it } from 'vitest';
import type { ToolNode } from '@/model';
import { toolFromItem } from './tool.def';

function searchItem(query: string) {
  return {
    kind: 'search-tool-call',
    id: 'search-1',
    seq: 0,
    toolCallId: 'call-1',
    title: 'Search',
    status: 'done',
    query,
  } satisfies Extract<ToolNode, { kind: 'search-tool-call' }>;
}

const ctx = {
  pendingToolCallIds: () => new Set<string>(),
} as SegmentCtx;

describe('toolFromItem', () => {
  it('preserves raw search queries that begin with search', () => {
    expect(toolFromItem(searchItem('search engine optimization'), ctx)).toMatchObject({
      name: 'Search',
      inputSummary: 'search engine optimization',
    });
  });

  it('preserves search summaries without the redundant prefix', () => {
    expect(toolFromItem(searchItem('SolidJS virtualized list patterns'), ctx)).toMatchObject({
      name: 'Search',
      inputSummary: 'SolidJS virtualized list patterns',
    });
  });

  it('labels orchestra tools and shows the conductor description', () => {
    const item = {
      kind: 'unknown-tool-call',
      id: 'tool-1',
      seq: 0,
      toolCallId: 'call-2',
      title: 'mcp__orkestra__spawn_agent',
      status: 'running',
      toolKind: 'other',
      name: 'mcp__orkestra__spawn_agent',
      inputSummary: 'Codex · GPT-6 Astra — API testlerini yaz',
    } satisfies Extract<ToolNode, { kind: 'unknown-tool-call' }>;
    expect(toolFromItem(item, ctx)).toMatchObject({
      name: 'İşçi başlat',
      inputSummary: 'Codex · GPT-6 Astra — API testlerini yaz',
    });
    expect(
      toolFromItem(
        { ...item, name: 'mcp__orkestra__wait_for_agents', inputSummary: undefined },
        ctx
      )
    ).toMatchObject({ name: 'İşçileri bekle', inputSummary: undefined });
  });

  it('labels Codex orchestra tools, which arrive as execute calls', () => {
    const item = {
      kind: 'execute-tool-call',
      id: 'tool-2',
      seq: 0,
      toolCallId: 'call-3',
      title: 'mcp.orkestra.message_agent',
      command: 'mcp.orkestra.message_agent',
      status: 'done',
      inputSummary: 'API testleri — hatayı düzelt',
    } satisfies Extract<ToolNode, { kind: 'execute-tool-call' }>;
    expect(toolFromItem(item, ctx)).toEqual({
      kind: 'tool',
      id: 'tool-2',
      name: 'İşçiye mesaj',
      status: 'done',
      awaitingPermission: false,
      inputSummary: 'API testleri — hatayı düzelt',
    });
    expect(
      toolFromItem(
        {
          ...item,
          title: 'mcp.orkestra.wait_for_agents',
          command: 'mcp.orkestra.wait_for_agents',
          inputSummary: undefined,
        },
        ctx
      )
    ).toMatchObject({ name: 'İşçileri bekle', inputSummary: undefined });
  });

  it('labels orchestra tools reported as structured MCP calls', () => {
    const item = {
      kind: 'mcp-tool-call',
      id: 'tool-3',
      seq: 0,
      toolCallId: 'call-4',
      title: 'list_workers',
      status: 'running',
      server: 'orkestra',
      tool: 'list_workers',
    } satisfies Extract<ToolNode, { kind: 'mcp-tool-call' }>;
    expect(toolFromItem(item, ctx)).toMatchObject({ name: 'İşçileri listele' });
    expect(toolFromItem({ ...item, server: 'linear' }, ctx)).toMatchObject({
      name: 'MCP',
      inputSummary: 'linear.list_workers',
    });
  });

  it('keeps unlabelled tools on their provider name', () => {
    const item = {
      kind: 'unknown-tool-call',
      id: 'tool-4',
      seq: 0,
      toolCallId: 'call-5',
      title: 'mcp__orkestra__future_tool',
      status: 'done',
      toolKind: 'other',
      name: 'mcp__orkestra__future_tool',
    } satisfies Extract<ToolNode, { kind: 'unknown-tool-call' }>;
    expect(toolFromItem(item, ctx)).toMatchObject({
      name: 'mcp__orkestra__future_tool',
      inputSummary: 'other',
    });
  });
});
