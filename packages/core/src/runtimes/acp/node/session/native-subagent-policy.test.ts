import { describe, expect, it } from 'vitest';
import { nativeSubagentInstructions } from './native-subagent-policy';

const config = (effort: string) => ({
  modelOptions: { configId: 'model', selected: 'provider/model', available: [] },
  efforts: { configId: 'thought_level', selected: effort, available: [] },
});

describe('native subagent instructions', () => {
  it.each(['high', 'xhigh', 'max', 'ultra'])('caps Codex %s at high', (effort) => {
    expect(nativeSubagentInstructions('codex', config(effort), 'review')).toContain(
      'Use reasoning effort high.'
    );
  });

  it.each(['codex', 'claude', 'opencode'])('preserves a lower %s selection', (provider) => {
    const policy = nativeSubagentInstructions(provider, config('low'), 'review');
    expect(policy).toContain('the parent session model (provider/model)');
    expect(policy).toContain('Use reasoning effort low.');
  });

  it.each([
    ['codex', 'gpt-example[ultra]', 'gpt-example'],
    ['opencode', 'provider/model#xhigh', 'provider/model'],
  ])('extracts model and effort from a composite %s option', (provider, id, model) => {
    const policy = nativeSubagentInstructions(
      provider,
      {
        modelOptions: { configId: 'model', selected: id, available: [] },
        efforts: null,
      },
      'review'
    );
    expect(policy).toContain(`the parent session model (${model})`);
    expect(policy).toContain('Use reasoning effort high.');
  });

  it('uses general native guidance when the provider or selection is unknown', () => {
    expect(nativeSubagentInstructions('other-provider', config('max'), 'review')).toContain(
      'Use reasoning effort high.'
    );
    expect(
      nativeSubagentInstructions('other-provider', { modelOptions: null, efforts: null }, 'review')
    ).toContain('Use the parent reasoning effort when known, capped at high.');
  });

  it('leaves slash commands alone', () => {
    expect(nativeSubagentInstructions('codex', config('max'), ' /review')).toBeUndefined();
  });

  it.each([
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-neon',
    'gemini-pro-orchestrator-argon',
  ])('leaves the Antigravity Orchestrator selection %s alone', (model) => {
    const selection = {
      ...config('ultra'),
      modelOptions: { ...config('ultra').modelOptions, selected: model },
    };
    expect(nativeSubagentInstructions('antigravity', selection, 'review')).toBeUndefined();
    expect(
      nativeSubagentInstructions(
        'antigravity',
        {
          modelOptions: null,
          efforts: null,
          collaborationModeOptions: {
            configId: 'collaboration_mode',
            selected: model,
            available: [],
          },
        },
        'review'
      )
    ).toBeUndefined();
  });

  it('uses common guidance in standard Antigravity sessions', () => {
    expect(nativeSubagentInstructions('antigravity', config('ultra'), 'review')).toContain(
      'Use reasoning effort high.'
    );
    expect(
      nativeSubagentInstructions(
        'antigravity',
        {
          modelOptions: null,
          efforts: null,
          collaborationModeOptions: {
            configId: 'collaboration_mode',
            selected: 'standard',
            available: [],
          },
        },
        'review'
      )
    ).toContain('If you use a provider-native subagent tool');
  });

  it('waits for the Antigravity catalog when the model and mode are unknown', () => {
    expect(
      nativeSubagentInstructions('antigravity', { modelOptions: null, efforts: null }, 'review')
    ).toBeUndefined();
  });
});
