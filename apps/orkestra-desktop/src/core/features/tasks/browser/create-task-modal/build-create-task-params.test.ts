import { asAgentProviderId, type AgentProviderId } from '@orkestra/plugins/agents/types';
import { describe, expect, it } from 'vitest';
import type { InitialConversationState } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { buildInitialConversation } from './build-create-task-params';

const agent = asAgentProviderId;

function makeInitialConversationState(
  provider: AgentProviderId,
  autoApprove: boolean,
  overrides: Partial<InitialConversationState> = {}
): InitialConversationState {
  return {
    provider,
    setProvider: () => {},
    prompt: 'Check this',
    setPrompt: () => {},
    issueContext: null,
    setIssueContext: () => {},
    autoApprove,
    setAutoApprove: () => {},
    issueContextEditorOpen: false,
    setIssueContextEditorOpen: () => {},
    model: null,
    setModel: () => {},
    useChatUi: false,
    setUseChatUi: () => {},
    initialPromptSupported: true,
    issueMentionContexts: {},
    setIssueMentionContext: () => {},
    ...overrides,
  };
}

describe('buildInitialConversation', () => {
  it('uses the draft auto-approve value for supported providers', () => {
    expect(buildInitialConversation(makeInitialConversationState(agent('claude'), true))).toEqual(
      expect.objectContaining({ provider: 'claude', autoApprove: true })
    );
  });

  it('preserves a capability-gated false auto-approve value', () => {
    expect(buildInitialConversation(makeInitialConversationState(agent('jules'), false))).toEqual(
      expect.objectContaining({ provider: 'jules', autoApprove: false })
    );
  });

  it('builds an ACP initial queue from prompt and stashed mention contexts', () => {
    const conversation = buildInitialConversation(
      makeInitialConversationState(agent('claude'), false, {
        useChatUi: true,
        prompt: 'Check (issue:github:123)',
        issueContext: 'Pinned issue context',
        issueMentionContexts: {
          'issue:github:123': 'Mention issue context',
        },
      })
    );

    expect(conversation?.type).toBe('acp');
    expect(conversation?.initialPrompt).toBeUndefined();
    expect(conversation?.initialQueue).toEqual([
      {
        text: 'Check (issue:github:123)',
        hiddenContext: 'Pinned issue context\n\nMention issue context',
      },
    ]);
  });

  it('omits PTY initial prompt when the selected agent cannot receive one', () => {
    const conversation = buildInitialConversation(
      makeInitialConversationState(agent('jules'), false, {
        initialPromptSupported: false,
      })
    );

    expect(conversation?.type).toBe('pty');
    expect(conversation?.initialPrompt).toBeUndefined();
  });

  it('starts the orchestra conductor as an ACP conversation with the prompt queued', () => {
    const settings = {
      conductorProviderId: 'codex',
      conductorModel: 'gpt-6-astra',
      workers: [{ providerId: 'claude', name: 'Claude Code', models: [] }],
      maxParallel: 0,
      autoApproveWorkers: true,
      routingNotes: '',
    };
    const result = buildInitialConversation(
      makeInitialConversationState(agent('claude'), false, {
        orchestra: {
          selected: true,
          setSelected: () => {},
          draft: { settings } as never,
          unavailableDescription: null,
        },
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        provider: 'codex',
        model: 'gpt-6-astra',
        autoApprove: true,
        type: 'acp',
        initialQueue: [{ text: 'Check this' }],
      })
    );
  });
});
