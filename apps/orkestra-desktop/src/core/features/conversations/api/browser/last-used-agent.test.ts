import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import {
  pickMostRecentAvailableAgent,
  readLastUsedAgent,
  recordLastUsedAgent,
  type OrderedAgentDescriptor,
} from './last-used-agent';

function makeConversation(
  overrides: Partial<Conversation> & Pick<Conversation, 'id' | 'providerId'>
): Conversation {
  return {
    projectId: 'proj-1',
    taskId: 'task-1',
    title: 'Sohbet',
    lastInteractedAt: null,
    isInitialConversation: true,
    ...overrides,
  };
}

const AGENTS: OrderedAgentDescriptor[] = [
  { id: 'claude' as AgentProviderId, supportsAcp: true },
  { id: 'codex' as AgentProviderId, supportsAcp: true },
  { id: 'antigravity' as AgentProviderId, supportsAcp: true },
];

describe('last-used-agent', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    });
  });

  it('picks the most recent non-superseded DB conversation with model and effort when cache is empty', () => {
    const picked = pickMostRecentAvailableAgent({
      cached: null,
      conversations: [
        makeConversation({
          id: 'c-old',
          providerId: 'claude',
          model: 'claude-sonnet-4-6',
          lastInteractedAt: '2026-11-24T10:00:00.000Z',
        }),
        makeConversation({
          id: 'c-new',
          providerId: 'codex',
          model: 'gpt-5.3-codex',
          effort: 'high',
          lastInteractedAt: '2026-11-24T11:30:00.000Z',
        }),
      ],
      orderedAgents: AGENTS,
      installedProviderIds: ['claude', 'codex', 'antigravity'] as AgentProviderId[],
      availabilityKnown: true,
      defaultAgent: 'claude' as AgentProviderId,
    });

    expect(picked).toEqual({
      providerId: 'codex',
      model: 'gpt-5.3-codex',
      effort: 'high',
    });
  });

  it('prefers newer localStorage record over older DB conversation timestamps', () => {
    const dbTime = Date.parse('2026-11-24T11:00:00.000Z');
    const picked = pickMostRecentAvailableAgent({
      cached: {
        providerId: 'antigravity' as AgentProviderId,
        model: 'gemini-3-pro',
        updatedAt: dbTime + 60_000,
      },
      conversations: [
        makeConversation({
          id: 'c-db',
          providerId: 'claude',
          model: 'claude-opus-4-6',
          lastInteractedAt: '2026-11-24T11:00:00.000Z',
        }),
      ],
      orderedAgents: AGENTS,
      installedProviderIds: ['claude', 'codex', 'antigravity'] as AgentProviderId[],
      availabilityKnown: true,
      defaultAgent: 'claude' as AgentProviderId,
    });

    expect(picked).toEqual({
      providerId: 'antigravity',
      model: 'gemini-3-pro',
    });
  });

  it('skips superseded conversations and falls back to their replacement or next most recent', () => {
    const picked = pickMostRecentAvailableAgent({
      cached: null,
      conversations: [
        makeConversation({
          id: 'c-superseded',
          providerId: 'claude',
          model: 'claude-opus-4-6',
          lastInteractedAt: '2026-11-24T12:00:00.000Z',
        }),
        makeConversation({
          id: 'c-replacement',
          providerId: 'codex',
          model: 'gpt-5.4',
          lastInteractedAt: '2026-11-24T11:55:00.000Z',
        }),
      ],
      supersededIds: new Set(['c-superseded']),
      orderedAgents: AGENTS,
      installedProviderIds: ['claude', 'codex'] as AgentProviderId[],
      availabilityKnown: true,
      defaultAgent: 'claude' as AgentProviderId,
    });

    expect(picked).toEqual({
      providerId: 'codex',
      model: 'gpt-5.4',
    });
  });

  it('falls back when the recent provider is not installed on the target host', () => {
    const pickedWithSecondaryConv = pickMostRecentAvailableAgent({
      cached: {
        providerId: 'antigravity' as AgentProviderId,
        model: 'orchestrator-max',
        updatedAt: Date.parse('2026-11-24T12:10:00.000Z'),
      },
      conversations: [
        makeConversation({
          id: 'c-ag',
          providerId: 'antigravity' as AgentProviderId,
          lastInteractedAt: '2026-11-24T12:05:00.000Z',
        }),
        makeConversation({
          id: 'c-codex',
          providerId: 'codex',
          model: 'gpt-5.3-codex',
          lastInteractedAt: '2026-11-24T11:00:00.000Z',
        }),
      ],
      orderedAgents: AGENTS,
      installedProviderIds: ['claude', 'codex'] as AgentProviderId[],
      availabilityKnown: true,
      defaultAgent: 'claude' as AgentProviderId,
    });

    expect(pickedWithSecondaryConv).toEqual({
      providerId: 'codex',
      model: 'gpt-5.3-codex',
    });

    const pickedDefault = pickMostRecentAvailableAgent({
      cached: {
        providerId: 'antigravity' as AgentProviderId,
        updatedAt: Date.now(),
      },
      conversations: [],
      orderedAgents: AGENTS,
      installedProviderIds: ['claude', 'codex'] as AgentProviderId[],
      availabilityKnown: true,
      defaultAgent: 'claude' as AgentProviderId,
    });

    expect(pickedDefault).toEqual({ providerId: 'claude' });
  });

  it('records and preserves model/effort on same provider while resetting on provider switch', () => {
    recordLastUsedAgent({ providerId: 'claude', model: 'claude-sonnet-4-6', effort: 'medium' });
    expect(readLastUsedAgent()).toMatchObject({
      providerId: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    });

    recordLastUsedAgent({ providerId: 'claude', effort: 'high' });
    expect(readLastUsedAgent()).toMatchObject({
      providerId: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });

    recordLastUsedAgent({ providerId: 'codex', model: 'gpt-5.4' });
    const afterSwitch = readLastUsedAgent();
    expect(afterSwitch).toMatchObject({
      providerId: 'codex',
      model: 'gpt-5.4',
    });
    expect(afterSwitch?.effort).toBeUndefined();
  });
});
