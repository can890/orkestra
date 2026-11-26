import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeSpawnEnv,
  CLAUDE_EXPERIMENTAL_OPUS_5_6_ID,
  orderClaudeConfigOptions,
  plugin,
} from './index';

describe('claude plugin Opus 5.6 support', () => {
  it('lists Claude Opus 5.6 in selectable catalog models', () => {
    expect(plugin.capabilities.models.kind).toBe('selectable');
    if (plugin.capabilities.models.kind !== 'selectable') return;
    const keys = Object.keys(plugin.capabilities.models.modelOptions);
    expect(keys).toContain(CLAUDE_EXPERIMENTAL_OPUS_5_6_ID);
    expect(keys.indexOf(CLAUDE_EXPERIMENTAL_OPUS_5_6_ID)).toBeLessThan(
      keys.indexOf('claude-opus-5-5')
    );
    expect(plugin.capabilities.models.modelOptions[CLAUDE_EXPERIMENTAL_OPUS_5_6_ID]?.name).toBe(
      'Claude Opus 5.6'
    );
  });

  it('injects ANTHROPIC_CUSTOM_MODEL_OPTION for Opus 5.6 unless user already set one', () => {
    const defaultEnv = buildClaudeSpawnEnv('/usr/local/bin/claude', {}, {});
    expect(defaultEnv).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'claude-opus-5-6',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Opus 5.6',
    });

    const userOverride = buildClaudeSpawnEnv(
      '/usr/local/bin/claude',
      { ANTHROPIC_CUSTOM_MODEL_OPTION: 'my-custom-claude' },
      {}
    );
    expect(userOverride.ANTHROPIC_CUSTOM_MODEL_OPTION).toBeUndefined();
  });

  it('places Opus 5.6 right above Opus 5.5 in live ACP model options', () => {
    const raw: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [
          { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5' },
          { value: 'opus', name: 'Opus 5.5', description: 'For complex work' },
          { value: 'sonnet', name: 'Sonnet 5.5', description: 'Efficient' },
          {
            value: 'claude-opus-5-6',
            name: 'Opus 5.6',
            description: 'Karmaşık ve günlük kodlama işleri için yeni nesil Opus modeli.',
          },
        ],
      },
    ];

    const ordered = orderClaudeConfigOptions(raw);
    const modelOpt = ordered?.[0];
    expect(modelOpt?.type).toBe('select');
    if (modelOpt?.type !== 'select') return;
    expect(modelOpt.options.map((entry) => ('value' in entry ? entry.value : entry.group))).toEqual(
      ['default', 'claude-opus-5-6', 'opus', 'sonnet']
    );
  });
});
