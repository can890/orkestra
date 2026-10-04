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
});
