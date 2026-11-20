import { describe, expect, it } from 'vitest';
import { buildGroupedModelEntries } from './model-effort-groups';

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
