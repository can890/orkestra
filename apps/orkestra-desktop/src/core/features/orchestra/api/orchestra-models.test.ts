import { findLiveModelOption } from '@orkestra/core/runtimes/acp/api/client';
import { describe, expect, it } from 'vitest';
import {
  capableOrchestraModels,
  cappedOrchestraEffort,
  effortForDifficulty,
  isReservedForDifficulty,
  orchestraModelProfile,
  pickEffortOption,
  recommendOrchestraModel,
  usableOrchestraModels,
} from './orchestra-models';

const codexModels = [
  { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', intelligence: 5, speed: 4 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', intelligence: 5, speed: 3 },
  { id: 'gpt-6-pro', name: 'GPT-6 Pro', intelligence: 5, speed: 2 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', intelligence: 5, speed: 3 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', intelligence: 4, speed: 5 },
  { id: 'gpt-5.5', name: 'GPT-5.5', intelligence: 5, speed: 3 },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', intelligence: 2, speed: 5 },
];

const claudeModels = [
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
];

describe('orchestra model catalog', () => {
  it('never offers GPT-6 Astra or older generations as worker models', () => {
    const usable = usableOrchestraModels('codex', codexModels).map((model) => model.id);
    expect(usable).toEqual(['gpt-6.2-sol', 'gpt-6-pro', 'gpt-6-luna']);
    expect(orchestraModelProfile('codex', codexModels[1]!).role).toBe('excluded');
  });

  it('routes Codex work to GPT-6.2 Sol and only light work to Luna', () => {
    expect(recommendOrchestraModel('codex', codexModels, 'critical')?.id).toBe('gpt-6.2-sol');
    expect(recommendOrchestraModel('codex', codexModels, 'hard')?.id).toBe('gpt-6.2-sol');
    expect(recommendOrchestraModel('codex', codexModels, 'standard')?.id).toBe('gpt-6.2-sol');
    expect(recommendOrchestraModel('codex', codexModels, 'trivial')?.id).toBe('gpt-6-luna');
  });

  it('reserves Claude Fable for critical work and uses Opus, Sonnet and Haiku below it', () => {
    expect(recommendOrchestraModel('claude', claudeModels, 'critical')?.id).toBe(
      'claude-fable-5-2'
    );
    expect(recommendOrchestraModel('claude', claudeModels, 'hard')?.id).toBe('claude-opus-5-5');
    expect(recommendOrchestraModel('claude', claudeModels, 'standard')?.id).toBe(
      'claude-sonnet-5-5'
    );
    expect(recommendOrchestraModel('claude', claudeModels, 'trivial')?.id).toBe('claude-haiku-5-5');
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
      { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    ];
    expect(recommendOrchestraModel('claude', scarce, 'critical')?.id).toBe('claude-fable-5-2');
    expect(recommendOrchestraModel('claude', scarce, 'hard')).toBeNull();
    expect(recommendOrchestraModel('claude', scarce, 'trivial')?.id).toBe('claude-haiku-5-5');
    expect(capableOrchestraModels('claude', claudeModels, 'hard').map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
    const fable = orchestraModelProfile('claude', claudeModels[0]!);
    expect(isReservedForDifficulty(fable, 'hard')).toBe(true);
    expect(isReservedForDifficulty(fable, 'critical')).toBe(false);
  });

  it("applies the conductor's Claude model through the option the session really offers", () => {
    // Karar verici seçicisi, Claude eklentisinin kataloğunu kendi adlarıyla listeler.
    const catalog = [
      { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', intelligence: 4, speed: 3 },
      { id: 'claude-fable-5', name: 'Claude Fable 5', intelligence: 4, speed: 3 },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', intelligence: 5, speed: 2 },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', intelligence: 5, speed: 2 },
      { id: 'claude-opus-5', name: 'Claude Opus 5', intelligence: 5, speed: 2 },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', intelligence: 4, speed: 4 },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', intelligence: 4, speed: 4 },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', intelligence: 3, speed: 5 },
    ];
    // Güncel Claude Code oturumu aynı modelleri kendi takma adlarıyla sunar.
    const claudeLive = [
      {
        id: 'default',
        name: 'Default (recommended)',
        description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
      },
      {
        id: 'opus[1m]',
        name: 'Opus 5.5',
        description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
      },
      {
        id: 'fable',
        name: 'Fable 5.2',
        description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks',
      },
      { id: 'sonnet', name: 'Sonnet 5.5', description: 'Sonnet 5.5 · Efficient for routine tasks' },
      { id: 'haiku', name: 'Haiku 5.5', description: 'Haiku 5.5 · Fastest for quick answers' },
    ];
    // Konuşma ayarına katalog kimliği yazılır; oturum açılırken aynı eşleyiciyle uygulanır.
    const applied = (id: string | undefined) =>
      id ? (findLiveModelOption({ id }, claudeLive)?.id ?? null) : null;

    // "Otomatik": en güçlü güncel model.
    const automatic = recommendOrchestraModel('claude', catalog, 'critical');
    expect(automatic?.id).toBe('claude-fable-5-2');
    expect(applied(automatic?.id)).toBe('fable');
    expect(applied('claude-opus-5-5')).toBe('opus[1m]');
    expect(applied('claude-sonnet-5-5')).toBe('sonnet');
    expect(applied('claude-haiku-5-5')).toBe('haiku');
    // Oturumun sunmadığı eski nesil, başka bir sürüme sessizce düşmez.
    expect(applied('claude-opus-4-8')).toBeNull();
    // Özel seçenekle sunulan deneysel Opus 5.6 tam kimliğiyle eşleşir.
    expect(
      findLiveModelOption(
        { id: 'claude-opus-5-6', name: 'Claude Opus 5.6' },
        [...claudeLive, { id: 'claude-opus-5-6', name: 'Opus 5.6', description: 'Experimental' }]
      )?.id
    ).toBe('claude-opus-5-6');
    expect(
      orchestraModelProfile('claude', { id: 'claude-opus-5-6', name: 'Claude Opus 5.6' })
    ).toMatchObject({ role: 'flagship', maxDifficulty: 'critical' });
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

  it('never selects an above-high effort for inherited worker settings', () => {
    for (const label of ['xhigh', 'extra high', 'çok yüksek', 'max', 'ultra']) {
      expect(cappedOrchestraEffort(label)).toBe('high');
    }
    expect(cappedOrchestraEffort('medium')).toBe('medium');
    expect(pickEffortOption([{ id: 'ultra', name: 'Ultra' }], 'high', true)).toBeNull();
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

  it('prefers an exact max effort over xhigh and ultra regardless of provider order', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((id) => ({
      id,
      name: id,
    }));
    expect(pickEffortOption(efforts, 'max')?.id).toBe('max');
    expect(
      pickEffortOption(
        efforts.filter((e) => e.id !== 'max'),
        'max'
      )?.id
    ).toBe('xhigh');
    expect(pickEffortOption([{ id: 'ultra', name: 'Ultra' }], 'max')?.id).toBe('ultra');
  });

  it('treats restricted Claude Mythos models as scarce flagships for critical work only', () => {
    const claude = [
      { id: 'claude-mythos-5-2', name: 'Claude Mythos 5.2' },
      { id: 'claude-mythos-5-1', name: 'Claude Mythos 5.1' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    ];
    const mythos = orchestraModelProfile('claude', claude[0]);
    expect(mythos).toMatchObject({ role: 'flagship', reserved: true });
    expect(orchestraModelProfile('claude', claude[1]).role).toBe('legacy');
    expect(isReservedForDifficulty(mythos, 'hard')).toBe(true);
    expect(isReservedForDifficulty(mythos, 'critical')).toBe(false);
    expect(recommendOrchestraModel('claude', claude, 'hard')?.id).toBe('claude-opus-5-5');
    expect(
      orchestraModelProfile('claude', { id: 'claude-mythos-6', name: 'Claude Mythos 6' }).reserved
    ).toBe(true);
  });

  it('ranks the Gemini 4 family and keeps orchestrator models out of worker use', () => {
    const gemini = [
      { id: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (Yüksek)' },
      { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (Yüksek)' },
      { id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (Çok Yüksek)' },
      { id: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Orta)' },
      { id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Düşük)' },
      { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (Yüksek)' },
      { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Orta)' },
      { id: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Düşük)' },
      { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
      { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (Yüksek)' },
    ];
    const usable = usableOrchestraModels('antigravity', gemini).map((model) => model.id);
    expect(usable).toEqual([
      'gemini-4-carbon-high',
      'gemini-4-neon-high',
      'gemini-4-neon-xhigh',
      'gemini-4-argon-high',
      'gemini-4-neon-medium',
      'gemini-4-argon-medium',
      'gemini-4-neon-low',
      'gemini-4-hydrogen-low',
    ]);
    expect(recommendOrchestraModel('antigravity', gemini, 'critical')?.id).toBe(
      'gemini-4-carbon-high'
    );
    expect(recommendOrchestraModel('antigravity', gemini, 'trivial')?.id).toBe(
      'gemini-4-hydrogen-low'
    );
  });
});
