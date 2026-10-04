import { describe, expect, it } from 'vitest';
import {
  effortForDifficulty,
  orchestraModelProfile,
  pickEffortOption,
  recommendOrchestraModel,
  usableOrchestraModels,
} from './orchestra-models';

const codexModels = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', intelligence: 5, speed: 4 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', intelligence: 5, speed: 3 },
  { id: 'gpt-6-pro', name: 'GPT-6 Pro', intelligence: 5, speed: 2 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', intelligence: 5, speed: 3 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', intelligence: 4, speed: 5 },
  { id: 'gpt-5.5', name: 'GPT-5.5', intelligence: 5, speed: 3 },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', intelligence: 2, speed: 5 },
];

const claudeModels = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
];

describe('orchestra model catalog', () => {
  it('never offers GPT-6 Astra or older generations as worker models', () => {
    const usable = usableOrchestraModels('codex', codexModels).map((model) => model.id);
    expect(usable).toEqual(['gpt-6.1-sol', 'gpt-6-pro', 'gpt-6-luna']);
    expect(orchestraModelProfile('codex', codexModels[1]!).role).toBe('excluded');
  });

  it('routes Codex work to GPT-6.1 Sol and only light work to Luna', () => {
    expect(recommendOrchestraModel('codex', codexModels, 'critical')?.id).toBe('gpt-6.1-sol');
    expect(recommendOrchestraModel('codex', codexModels, 'hard')?.id).toBe('gpt-6.1-sol');
    expect(recommendOrchestraModel('codex', codexModels, 'standard')?.id).toBe('gpt-6.1-sol');
    expect(recommendOrchestraModel('codex', codexModels, 'trivial')?.id).toBe('gpt-6-luna');
  });

  it('reserves Claude Fable for critical work and uses Opus, Sonnet and Haiku below it', () => {
    expect(recommendOrchestraModel('claude', claudeModels, 'critical')?.id).toBe(
      'claude-fable-5-1'
    );
    expect(recommendOrchestraModel('claude', claudeModels, 'hard')?.id).toBe('claude-opus-5-5');
    expect(recommendOrchestraModel('claude', claudeModels, 'standard')?.id).toBe(
      'claude-sonnet-5-5'
    );
    expect(recommendOrchestraModel('claude', claudeModels, 'trivial')?.id).toBe('claude-haiku-4-5');
  });

  it('returns no model when a provider cannot handle the difficulty', () => {
    const glm = [
      { id: 'glm-5.3', name: 'GLM 5.3' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
    ];
    expect(recommendOrchestraModel('glm', glm, 'critical')).toBeNull();
    expect(recommendOrchestraModel('glm', glm, 'standard')?.id).toBe('glm-5.3');
  });

  it('infers profiles for models missing from the catalog', () => {
    expect(orchestraModelProfile('new', { id: 'x-pro', name: 'X Pro', intelligence: 5 }).role).toBe(
      'flagship'
    );
    expect(orchestraModelProfile('new', { id: 'x-mini', name: 'X Mini' }).maxDifficulty).toBe(
      'trivial'
    );
  });

  it('maps difficulty to reasoning effort and provider effort options', () => {
    expect(effortForDifficulty('critical')).toBe('max');
    expect(effortForDifficulty('trivial')).toBe('low');
    const codexEfforts = [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Extra high' },
    ];
    expect(pickEffortOption(codexEfforts, 'max')?.id).toBe('xhigh');
    expect(pickEffortOption(codexEfforts, 'high')?.id).toBe('high');
    expect(pickEffortOption(codexEfforts.slice(0, 3), 'max')?.id).toBe('high');
    expect(pickEffortOption([{ id: 'think', name: 'Think' }], 'high')).toBeNull();
  });
});
