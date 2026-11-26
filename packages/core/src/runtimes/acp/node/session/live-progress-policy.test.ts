import { describe, expect, it } from 'vitest';
import { antigravityLiveProgressInstructions } from './live-progress-policy';

const configWithModel = (selected: string) => ({
  modelOptions: { configId: 'model', selected, available: [] },
});

describe('antigravity live progress instructions', () => {
  it('enables live progress guidance for Antigravity Gemini and orchestrator models', () => {
    for (const model of [
      'gemini-4-neon-high',
      'gemini-4-hydrogen-medium',
      'gemini-pro-orchestrator-neon',
      '',
    ]) {
      const guidance = antigravityLiveProgressInstructions(
        'antigravity',
        configWithModel(model),
        'Bu hatayı incele ve düzelt'
      );
      expect(guidance).toContain('Claude Code and Codex');
      expect(guidance).toContain('right before your first tool call');
    }
  });

  it('skips Claude models routed through Antigravity', () => {
    expect(
      antigravityLiveProgressInstructions(
        'antigravity',
        configWithModel('claude-opus-5-5-high'),
        'Bu hatayı incele'
      )
    ).toBeUndefined();
  });

  it('leaves slash commands and non-Antigravity providers alone', () => {
    expect(
      antigravityLiveProgressInstructions(
        'antigravity',
        configWithModel('gemini-4-neon-high'),
        ' /plan yeni özellik'
      )
    ).toBeUndefined();
    expect(
      antigravityLiveProgressInstructions('codex', configWithModel('gpt-6.2-sol'), 'İncele')
    ).toBeUndefined();
    expect(
      antigravityLiveProgressInstructions('claude', configWithModel('opus'), 'İncele')
    ).toBeUndefined();
  });
});
