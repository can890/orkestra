import type { ComposerAgentOption } from './index';

export const HANDOFF_CURRENT_GROUP_LABEL = 'Şu anki ajan';
export const HANDOFF_OTHERS_GROUP_LABEL = 'Başka ajanla devam et';

export interface HandoffAgentGroup {
  label: string;
  items: ComposerAgentOption[];
}

/**
 * Agent list for a conversation that already has history: the running agent stays on top as the
 * selected row, every other agent is listed under a "continue with another agent" heading.
 * Options keep their incoming order; the host decides which agents are eligible and how they are
 * ranked. Empty groups are omitted.
 */
export function buildHandoffAgentGroups(
  options: readonly ComposerAgentOption[],
  currentId: string | undefined
): HandoffAgentGroup[] {
  const current = options.filter((option) => option.id === currentId);
  const others = options.filter((option) => option.id !== currentId);
  const groups: HandoffAgentGroup[] = [];
  if (current.length > 0) groups.push({ label: HANDOFF_CURRENT_GROUP_LABEL, items: current });
  if (others.length > 0) groups.push({ label: HANDOFF_OTHERS_GROUP_LABEL, items: others });
  return groups;
}
