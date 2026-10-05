import type { SegmentCtx } from '@core/units';
import { describe, expect, it } from 'vitest';
import type { ToolNode } from '@/model';
import type { OrchestraToolCallNode } from './orchestra-tool';
import { orchestraWorkerFromItem } from './subagent.def';

const ctx = {
  pendingToolCallIds: () => new Set<string>(['call-pending']),
} as SegmentCtx;

/** Codex reports the conductor's `spawn_agent` MCP call as an execute call. */
const codexSpawn = (status: ToolNode['status'], inputSummary?: string): OrchestraToolCallNode => ({
  kind: 'execute-tool-call',
  id: 'item-1',
  seq: 0,
  toolCallId: 'call-1',
  title: 'mcp.orkestra.spawn_agent',
  command: 'mcp.orkestra.spawn_agent',
  status,
  ...(inputSummary !== undefined ? { inputSummary } : {}),
});

describe('orchestraWorkerFromItem', () => {
  it('maps a Codex spawn call to an Orkestra worker row named by its description', () => {
    expect(orchestraWorkerFromItem(codexSpawn('running', ' Codex — testler '), ctx)).toEqual({
      kind: 'subagent',
      id: 'item-1',
      name: 'Codex — testler',
      status: 'running',
      phase: 'spawning',
      awaitingPermission: false,
      toolCallId: 'call-1',
      source: 'orchestra-worker',
    });
  });

  it('derives the launch phase from the call status', () => {
    expect(orchestraWorkerFromItem(codexSpawn('done', 'x'), ctx).phase).toBe('running');
    expect(orchestraWorkerFromItem(codexSpawn('error', 'x'), ctx).phase).toBe('failed');
  });

  it('falls back to a generic name and reports pending permission', () => {
    const row = orchestraWorkerFromItem(
      { ...codexSpawn('running', '  '), toolCallId: 'call-pending' },
      ctx
    );
    expect(row).toMatchObject({ name: 'Orkestra işçisi', awaitingPermission: true });
  });
});
