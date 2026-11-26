import { describe, expect, it } from 'vitest';
import { antigravityLiveProgressInstructions } from './live-progress-policy';

const configWithModel = (selected: string) => ({
  modelOptions: { configId: 'model', selected, available: [] },
});

describe('live progress instructions', () => {
  it('enables live progress guidance for Antigravity (Gemini, Orchestrator, Claude) and Claude sessions', () => {
    const cases: Array<[string, string]> = [
      ['antigravity', 'gemini-4-neon-high'],
      ['antigravity', 'gemini-4-hydrogen-medium'],
      ['antigravity', 'gemini-pro-orchestrator-neon'],
      ['antigravity', 'claude-opus-5-5-high'],
      ['antigravity', ''],
      ['claude', 'opus'],
      ['claude', 'default'],
    ];
    for (const [provider, model] of cases) {
      const guidance = antigravityLiveProgressInstructions(
        provider,
        configWithModel(model),
        'Bu hatayı incele ve düzelt'
      );
      expect(guidance).toContain('For multi-step or tool-using requests');
      expect(guidance).toContain('right before your first tool call');
    }
  });

  it('leaves slash commands and other providers alone', () => {
    expect(
      antigravityLiveProgressInstructions(
        'antigravity',
        configWithModel('gemini-4-neon-high'),
        ' /plan yeni özellik'
      )
    ).toBeUndefined();
    expect(
      antigravityLiveProgressInstructions('claude', configWithModel('opus'), '/compact')
    ).toBeUndefined();
    expect(
      antigravityLiveProgressInstructions('codex', configWithModel('gpt-6.2-sol'), 'İncele')
    ).toBeUndefined();
  });
});
