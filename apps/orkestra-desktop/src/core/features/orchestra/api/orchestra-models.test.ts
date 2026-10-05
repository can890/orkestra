import { describe, expect, it } from 'vitest';
import {
  capableOrchestraModels,
  effortForDifficulty,
  findCatalogModel,
  findLiveModelOption,
  isReservedForDifficulty,
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

  it('applies the product rules to whole model families, not just catalog ids', () => {
    const astra = { id: 'gpt-6.1-astra', name: 'GPT-6.1 Astra', intelligence: 5, speed: 4 };
    expect(orchestraModelProfile('codex', astra).role).toBe('excluded');
    expect(orchestraModelProfile('antigravity', { id: 'gpt-6-astra-high', name: 'x' }).role).toBe(
      'excluded'
    );
    expect(orchestraModelProfile('other', { id: 'model-x', name: 'Astra' }).role).toBe('excluded');
    expect(orchestraModelProfile('other', { id: 'astral-1', name: 'Astral' }).role).not.toBe(
      'excluded'
    );
    expect(usableOrchestraModels('codex', [...codexModels, astra]).map((m) => m.id)).not.toContain(
      'gpt-6.1-astra'
    );
    expect(recommendOrchestraModel('codex', [astra], 'critical')).toBeNull();

    const fable = { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', intelligence: 5 };
    expect(orchestraModelProfile('claude', fable).reserved).toBe(true);
    expect(
      orchestraModelProfile('claude', { id: 'claude-fable-5', name: 'Fable 5' }).reserved
    ).toBe(true);
  });

  it('never recommends a reserved model below critical difficulty', () => {
    const scarce = [
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ];
    expect(recommendOrchestraModel('claude', scarce, 'critical')?.id).toBe('claude-fable-5-1');
    expect(recommendOrchestraModel('claude', scarce, 'hard')).toBeNull();
    expect(recommendOrchestraModel('claude', scarce, 'trivial')?.id).toBe('claude-haiku-4-5');
    expect(capableOrchestraModels('claude', claudeModels, 'hard').map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
    const fable = orchestraModelProfile('claude', claudeModels[0]!);
    expect(isReservedForDifficulty(fable, 'hard')).toBe(true);
    expect(isReservedForDifficulty(fable, 'critical')).toBe(false);
  });

  it('maps catalog models to the options a provider session really offers', () => {
    // Claude Code ACP modelleri takma adlarla ve bağlam ipuçlarıyla sunar.
    const claudeLive = [
      {
        id: 'default',
        name: 'Default (recommended)',
        description: 'Use the default model (currently Opus 4.8 (1M context))',
      },
      { id: 'opus[1m]', name: 'Opus', description: 'Opus 4.8 with 1M context · Complex tasks' },
      { id: 'claude-fable-5[1m]', name: 'Fable', description: 'Fable 5 · Most capable' },
      { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
      { id: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest' },
    ];
    const find = (id: string, name: string) => findLiveModelOption({ id, name }, claudeLive)?.id;
    expect(find('claude-opus-4-8', 'Claude Opus 4.8')).toBe('opus[1m]');
    expect(find('claude-opus-5-5', 'Claude Opus 5.5')).toBeUndefined();
    expect(find('claude-fable-5', 'Claude Fable 5')).toBe('claude-fable-5[1m]');
    expect(find('claude-fable-5-1', 'Claude Fable 5.1')).toBeUndefined();
    expect(find('claude-sonnet-5', 'Claude Sonnet 5')).toBe('sonnet');
    expect(find('claude-sonnet-5-5', 'Claude Sonnet 5.5')).toBeUndefined();
    expect(find('claude-haiku-4-5', 'Claude Haiku 4.5')).toBe('haiku');
    // Sürüm yazmayan takma ad aileyle eşleşir; "default" hiçbir modelle eşleşmez.
    const opus = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
    expect(findLiveModelOption(opus, [{ id: 'opus', name: 'Opus' }])?.id).toBe('opus');
    expect(findLiveModelOption(opus, [claudeLive[0]!])).toBeNull();
    // Tam kimlikler (Codex) doğrudan eşleşir; başka sürüm eşleşmez.
    const sol = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' };
    expect(findLiveModelOption(sol, [{ id: 'GPT-6.1-SOL', name: 'x' }])?.id).toBe('GPT-6.1-SOL');
    expect(findLiveModelOption(sol, [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }])).toBeNull();
    expect(
      findCatalogModel(claudeModels, { id: 'opus[1m]', name: 'Opus', description: 'Opus 5.5' })?.id
    ).toBe('claude-opus-5-5');
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
