import type { CommandContext } from '@orkestra/core/services/agent-plugins/api/plugins';
import { describe, expect, it } from 'vitest';
import { provider as grok } from './grok';
import { provider as kimi } from './kimi';

// Sohbet ↔ terminal geçişi, ACP'nin ürettiği oturum kimliğiyle CLI'nin aynı oturuma dönmesine dayanır.
function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cli: 'agent',
    autoApprove: false,
    sessionId: 'conversation-id',
    isResuming: false,
    model: '',
    ...overrides,
  };
}

describe('Grok model catalog', () => {
  it('lists every model the Grok CLI offers, with its display names', () => {
    const models = grok.capabilities.models;
    if (models.kind !== 'selectable') throw new Error('Grok models are not selectable');
    expect(
      Object.fromEntries(Object.entries(models.modelOptions).map(([id, o]) => [id, o.name]))
    ).toEqual({
      'grok-4.7': 'Grok 4.7',
      'grok-4.7-build-fast': 'Grok 4.7 Fast',
      'grok-4.6': 'Grok 4.6',
      'grok-4.5': 'Grok 4.5',
    });
  });

  it('passes the selected model to the terminal session', () => {
    const args = grok.behavior.prompt!.buildCommand(ctx({ model: 'grok-4.6' })).args;
    expect(args).toEqual(['-m', 'grok-4.6']);
  });
});

describe('chat ↔ terminal session handoff', () => {
  it('Grok resumes the ACP session id with -r and keeps the model and approval mode', () => {
    const args = grok.behavior.prompt!.buildCommand(
      ctx({
        isResuming: true,
        providerSessionId: '01a10889-02e1-7043-8beb-c8071aa18201',
        autoApprove: true,
        model: 'grok-4.7-build-fast',
      })
    ).args;
    expect(args).toEqual([
      '-r',
      '01a10889-02e1-7043-8beb-c8071aa18201',
      '--always-approve',
      '-m',
      'grok-4.7-build-fast',
    ]);
  });

  it('Kimi resumes the ACP session id with -S', () => {
    const args = kimi.behavior.prompt!.buildCommand(
      ctx({
        isResuming: true,
        providerSessionId: 'session_ebdc4615-036f-4138-bb1f-35b773be3149',
        model: 'kimi-code/k3',
      })
    ).args;
    expect(args).toEqual([
      '-S',
      'session_ebdc4615-036f-4138-bb1f-35b773be3149',
      '--model',
      'kimi-code/k3',
    ]);
  });

  it('both providers support ACP and resumable sessions', () => {
    for (const provider of [grok, kimi]) {
      expect(provider.capabilities.acp).toEqual({ kind: 'supported' });
      expect(provider.capabilities.sessions).toEqual({ kind: 'resumable' });
    }
  });
});
