import { describe, expect, it } from 'vitest';
import { layoutAgentGraph } from './agent-flow-diagram';
import type { AgentGraphNode } from './subagent-activity';

const node = (id: string, children: AgentGraphNode[] = [], extra: Partial<AgentGraphNode> = {}) =>
  ({
    id,
    kind: id === 'root' ? 'root' : 'subagent',
    label: id,
    phase: 'running',
    steps: 0,
    children,
    ...extra,
  }) satisfies AgentGraphNode;

describe('layoutAgentGraph', () => {
  it('places nodes top-down in pre-order and indents each level', () => {
    const layout = layoutAgentGraph(
      node('root', [node('a', [node('a1')]), node('b', [], { detail: 'Codex · GPT-6.1 Sol' })])
    );
    expect(layout.nodes.map((placed) => [placed.node.id, placed.depth])).toEqual([
      ['root', 0],
      ['a', 1],
      ['a1', 2],
      ['b', 1],
    ]);
    const [root, a, a1, b] = layout.nodes;
    expect(a!.x - root!.x).toBe(a1!.x - a!.x);
    expect(b!.x).toBe(a!.x);
    expect(a!.y).toBeGreaterThan(root!.y + root!.height);
    expect(b!.height).toBeGreaterThan(a!.height);
    expect(a1!.parent?.node.id).toBe('a');
    expect(layout.height).toBeGreaterThan(b!.y + b!.height);
  });
});
