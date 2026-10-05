import { describe, expect, it } from 'vitest';
import {
  claudeLiveModelOptions,
  recordedClaudeLiveModelOptions,
} from '#runtimes/acp/node/acp-test-support';
import { findCatalogModel, findLiveModelOption } from './model-match';

const claudeCatalog = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
];

function liveIdFor(id: string, options: readonly { id: string; name: string }[]) {
  return findLiveModelOption({ id }, options)?.id ?? null;
}

describe('findLiveModelOption', () => {
  it('maps Claude catalog ids to the aliases a current Claude Code session offers', () => {
    expect(liveIdFor('claude-fable-5-1', claudeLiveModelOptions)).toBe('fable');
    expect(liveIdFor('claude-opus-5-5', claudeLiveModelOptions)).toBe('opus[1m]');
    expect(liveIdFor('claude-sonnet-5-5', claudeLiveModelOptions)).toBe('sonnet');
    expect(liveIdFor('claude-haiku-4-5', claudeLiveModelOptions)).toBe('haiku');
    // Eski nesiller güncel takma adlara düşmez; oturum onları sunmuyor.
    expect(liveIdFor('claude-opus-4-8', claudeLiveModelOptions)).toBeNull();
    expect(liveIdFor('claude-sonnet-5', claudeLiveModelOptions)).toBeNull();
    expect(liveIdFor('claude-fable-5', claudeLiveModelOptions)).toBeNull();
  });

  it('never maps a catalog model to an alias of another version', () => {
    // Kayıtlı fikstürdeki eski oturum: adlar sürümsüz, sürüm yalnızca açıklamada.
    const options = recordedClaudeLiveModelOptions;
    expect(liveIdFor('claude-opus-4-8', options)).toBe('opus[1m]');
    expect(liveIdFor('claude-opus-5-5', options)).toBeNull();
    expect(liveIdFor('claude-fable-5', options)).toBe('claude-fable-5[1m]');
    expect(liveIdFor('claude-fable-5-1', options)).toBeNull();
    expect(liveIdFor('claude-sonnet-5', options)).toBe('sonnet');
    expect(liveIdFor('claude-sonnet-5-5', options)).toBeNull();
    expect(liveIdFor('claude-haiku-4-5', options)).toBe('haiku');
  });

  it('matches a full id that only adds a context hint', () => {
    const fable = {
      id: 'claude-fable-5-1[1m]',
      name: 'Fable',
      description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
    };
    expect(liveIdFor('claude-fable-5-1', [fable])).toBe('claude-fable-5-1[1m]');
    expect(liveIdFor('claude-fable-5', [fable])).toBeNull();
    expect(liveIdFor('fable[1m]', [{ id: 'fable', name: 'Fable 5.1' }])).toBe('fable');
  });

  it('prefers the option without a context hint when both context lanes are offered', () => {
    const extended = {
      id: 'opus[1m]',
      name: 'Opus (1M context)',
      description: 'Opus 5.5 with 1M context · Draws from usage credits',
    };
    const standard = {
      id: 'opus',
      name: 'Opus',
      description: 'Opus 5.5 · Best for everyday, complex tasks',
    };
    expect(liveIdFor('claude-opus-5-5', [extended, standard])).toBe('opus');
    expect(liveIdFor('claude-opus-5-5', [standard, extended])).toBe('opus');
    expect(liveIdFor('claude-opus-5-5[1m]', [standard, extended])).toBe('opus[1m]');
    expect(liveIdFor('opus[1m]', [standard, extended])).toBe('opus[1m]');
  });

  it('falls back to an alias without version information but never to default', () => {
    const opus = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
    expect(findLiveModelOption(opus, [{ id: 'opus', name: 'Opus' }])?.id).toBe('opus');
    expect(findLiveModelOption(opus, [{ id: 'opus', name: 'Opus', description: '' }])?.id).toBe(
      'opus'
    );
    // Varsayılan seçenek hangi modele çözüldüğünü yazsa da eşlenmez.
    expect(findLiveModelOption(opus, [claudeLiveModelOptions[0]!])).toBeNull();
    expect(findLiveModelOption({ id: '' }, claudeLiveModelOptions)).toBeNull();
  });

  it('matches exact ids case-insensitively and rejects other versions', () => {
    const sol = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' };
    expect(findLiveModelOption(sol, [{ id: 'GPT-6.1-SOL', name: 'x' }])?.id).toBe('GPT-6.1-SOL');
    expect(findLiveModelOption(sol, [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }])).toBeNull();
    expect(
      findLiveModelOption(sol, [
        { id: 'gpt-6-pro', name: 'GPT-6 Pro' },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      ])
    ).toBeNull();
  });

  it('uses the catalog name when the id carries no version', () => {
    const named = { id: 'claude-opus', name: 'Claude Opus 5.5' };
    expect(findLiveModelOption(named, claudeLiveModelOptions)?.id).toBe('opus[1m]');
    expect(findLiveModelOption(named, recordedClaudeLiveModelOptions)).toBeNull();
  });
});

describe('findCatalogModel', () => {
  it('finds the catalog model behind a live option', () => {
    expect(
      findCatalogModel(claudeCatalog, { id: 'opus[1m]', name: 'Opus', description: 'Opus 5.5' })?.id
    ).toBe('claude-opus-5-5');
    expect(findCatalogModel(claudeCatalog, claudeLiveModelOptions[2]!)?.id).toBe(
      'claude-fable-5-1'
    );
    expect(findCatalogModel(claudeCatalog, claudeLiveModelOptions[0]!)).toBeNull();
  });
});
