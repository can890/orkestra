import { describe, expect, it } from 'vitest';
import {
  buildHandoffAgentGroups,
  HANDOFF_CURRENT_GROUP_LABEL,
  HANDOFF_OTHERS_GROUP_LABEL,
} from './agent-handoff-groups';

const agents = [
  { id: 'kimi', name: 'Kimi' },
  { id: 'claude', name: 'Claude', badge: { label: 'limit doldu', tone: 'danger' as const } },
  { id: 'codex', name: 'Codex' },
];

describe('buildHandoffAgentGroups', () => {
  it('puts the current agent first and lists the others under the handoff heading', () => {
    const groups = buildHandoffAgentGroups(agents, 'kimi');
    expect(groups.map((group) => group.label)).toEqual([
      HANDOFF_CURRENT_GROUP_LABEL,
      HANDOFF_OTHERS_GROUP_LABEL,
    ]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['kimi']);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(['claude', 'codex']);
  });

  it('keeps badges and incoming order', () => {
    const others = buildHandoffAgentGroups(agents, 'codex')[1]?.items ?? [];
    expect(others.map((item) => item.id)).toEqual(['kimi', 'claude']);
    expect(others[1]?.badge?.label).toBe('limit doldu');
  });

  it('omits empty groups', () => {
    expect(buildHandoffAgentGroups([agents[0]!], 'kimi').map((g) => g.label)).toEqual([
      HANDOFF_CURRENT_GROUP_LABEL,
    ]);
    expect(buildHandoffAgentGroups(agents, 'missing').map((g) => g.label)).toEqual([
      HANDOFF_OTHERS_GROUP_LABEL,
    ]);
  });
});
