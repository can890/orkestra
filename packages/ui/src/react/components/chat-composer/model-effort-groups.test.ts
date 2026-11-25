import { describe, expect, it } from 'vitest';
import { buildGroupedModelEntries, modellessAgentLabel } from './model-effort-groups';

describe('buildGroupedModelEntries', () => {
  it('groups Antigravity effort variants under one base model sorted low to xhigh', () => {
    const models = [
      { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (Yüksek)' },
      { id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (Çok Yüksek)' },
      { id: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Orta)' },
      { id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Düşük)' },
      { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Orta)' },
    ];

    const { entries, trigger } = buildGroupedModelEntries(models, [], 'gemini-4-neon-high', null);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      kind: 'embedded-group',
      baseName: 'Gemini 4 Neon',
      isSelected: true,
      activeVariant: { value: 'gemini-4-neon-high', label: 'Yüksek' },
    });
    if (entries[0]?.kind === 'embedded-group') {
      expect(entries[0].variants.map((v) => v.label)).toEqual([
        'Düşük',
        'Orta',
        'Yüksek',
        'Çok Yüksek',
      ]);
    }
    // Non-effort parentheticals and single-variant models remain standalone.
    expect(entries[1]).toMatchObject({
      kind: 'model',
      id: 'gemini-pro-orchestrator-neon',
      name: 'Orchestrator (Neon)',
      efforts: [],
    });
    expect(entries[2]).toMatchObject({
      kind: 'model',
      id: 'gpt-oss-120b-medium',
      name: 'GPT-OSS 120B (Orta)',
      efforts: [],
    });
    expect(trigger).toEqual({ label: 'Gemini 4 Neon', effortLabel: 'Yüksek' });
  });

  it('attaches separate provider effort options to each model row', () => {
    const models = [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    ];
    const efforts = [
      { id: 'high', name: 'Yüksek' },
      { id: 'low', name: 'Düşük' },
      { id: 'medium', name: 'Orta' },
    ];

    const { entries, trigger } = buildGroupedModelEntries(
      models,
      efforts,
      'claude-opus-5-5',
      'high'
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'model',
      id: 'claude-opus-5-5',
      isSelected: true,
      activeEffort: { value: 'high', label: 'Yüksek' },
    });
    if (entries[0]?.kind === 'model') {
      expect(entries[0].efforts.map((e) => e.label)).toEqual(['Düşük', 'Orta', 'Yüksek']);
    }
    expect(entries[1]).toMatchObject({
      kind: 'model',
      id: 'claude-sonnet-5-5',
      isSelected: false,
      activeEffort: null,
    });
    expect(trigger).toEqual({ label: 'Claude Opus 5.5', effortLabel: 'Yüksek' });
  });
});

describe('modellessAgentLabel', () => {
  const custom = { id: 'acp-local-hizli-ajan', name: 'Hızlı Ajan', models: {} };
  const claude = { id: 'claude', name: 'Claude', models: { opus: { name: 'Opus' } } };

  it('names an agent that reports no models instead of a placeholder', () => {
    expect(
      modellessAgentLabel({
        liveModelCount: 0,
        providers: [claude, custom],
        selectedProvider: 'acp-local-hizli-ajan',
      })
    ).toBe('Hızlı Ajan');
  });

  it('treats a catalog entry that only carries a default placeholder as modelless', () => {
    expect(
      modellessAgentLabel({
        liveModelCount: 0,
        providers: [
          { ...custom, models: { __default__: { name: 'Varsayılan' } }, modelless: true },
        ],
        selectedProvider: 'acp-local-hizli-ajan',
      })
    ).toBe('Hızlı Ajan');
  });

  it('keeps the placeholder while models exist or are still loading', () => {
    expect(
      modellessAgentLabel({ liveModelCount: 0, providers: [claude], selectedProvider: 'claude' })
    ).toBeNull();
    expect(
      modellessAgentLabel({
        liveModelCount: 2,
        providers: [custom],
        selectedProvider: 'acp-local-hizli-ajan',
      })
    ).toBeNull();
    expect(modellessAgentLabel({ liveModelCount: 0, providers: null, selectedProvider: 'x' })).toBe(
      null
    );
  });
});
