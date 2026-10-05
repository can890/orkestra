import { describe, expect, it } from 'vitest';
import type { AgentMetadata } from '@core/primitives/agents/api';
import {
  catalogModelName,
  clearedModelNoticeMessage,
  ClearedModelNotices,
} from './cleared-model-notice';

const clearedModel = (model?: string) => ({
  clearedConfiguration: ['model' as const],
  ...(model !== undefined && { clearedValues: { model } }),
});

describe('clearedModelNoticeMessage', () => {
  it('names the dropped model when it is known', () => {
    expect(clearedModelNoticeMessage('Claude Opus 4.8')).toBe(
      'Seçtiğiniz model (Claude Opus 4.8) bu oturumda sunulmuyor; varsayılan model kullanılıyor.'
    );
  });

  it('falls back to a generic notice when the runtime reports only the key', () => {
    expect(clearedModelNoticeMessage(null)).toBe(
      'Seçtiğiniz model bu oturumda sunulmuyor; varsayılan model kullanılıyor.'
    );
  });
});

describe('catalogModelName', () => {
  const agents = [
    {
      id: 'claude',
      capabilities: {
        models: {
          kind: 'selectable',
          modelOptions: { 'claude-opus-4-8': { name: 'Claude Opus 4.8' } },
        },
      },
    },
    { id: 'plain', capabilities: { models: { kind: 'none' } } },
  ] as unknown as AgentMetadata[];

  it('uses the display name from the provider catalog', () => {
    expect(catalogModelName(agents, 'claude', 'claude-opus-4-8')).toBe('Claude Opus 4.8');
  });

  it.each([
    ['a model missing from the catalog', 'claude', 'opus[1m]'],
    ['an inherited object key', 'claude', 'constructor'],
    ['a provider without a model catalog', 'plain', 'some-model'],
    ['an unknown provider', 'unknown', 'claude-opus-4-8'],
  ])('falls back to the raw id for %s', (_case, providerId, modelId) => {
    expect(catalogModelName(agents, providerId, modelId)).toBe(modelId);
  });
});

describe('ClearedModelNotices', () => {
  it('announces one clearing once while the runtime keeps reporting it', () => {
    const notices = new ClearedModelNotices();

    expect(notices.take('conversation-1', clearedModel('claude-opus-4-8'))).toEqual({
      modelId: 'claude-opus-4-8',
    });
    // Reopening the conversation or refreshing its history repeats the same report.
    expect(notices.take('conversation-1', clearedModel('claude-opus-4-8'))).toBeUndefined();
    expect(notices.take('conversation-1', clearedModel('claude-opus-4-8'))).toBeUndefined();
  });

  it('announces a later clearing after a report without the model', () => {
    const notices = new ClearedModelNotices();
    notices.take('conversation-1', clearedModel('claude-opus-4-8'));

    // The user chose a new model, so the runtime stopped reporting the old clearing.
    expect(notices.take('conversation-1', {})).toBeUndefined();
    expect(notices.take('conversation-1', clearedModel('claude-opus-4-8'))).toEqual({
      modelId: 'claude-opus-4-8',
    });
  });

  it('announces a different cleared model', () => {
    const notices = new ClearedModelNotices();
    notices.take('conversation-1', clearedModel('claude-opus-4-8'));

    expect(notices.take('conversation-1', clearedModel('sonnet'))).toEqual({ modelId: 'sonnet' });
  });

  it('announces a key-only report once without a model id', () => {
    const notices = new ClearedModelNotices();

    expect(notices.take('conversation-1', clearedModel())).toEqual({ modelId: null });
    expect(notices.take('conversation-1', clearedModel())).toBeUndefined();
    expect(notices.take('conversation-1', clearedModel('claude-opus-4-8'))).toBeUndefined();
  });

  it('stays silent for cleared effort or mode selections', () => {
    const notices = new ClearedModelNotices();

    expect(
      notices.take('conversation-1', {
        clearedConfiguration: ['effort', 'modeId'],
        clearedValues: { effort: 'max', modeId: 'plan' },
      })
    ).toBeUndefined();
  });

  it('tracks conversations independently', () => {
    const notices = new ClearedModelNotices();
    notices.take('conversation-1', clearedModel('claude-opus-4-8'));

    expect(notices.take('conversation-2', clearedModel('claude-opus-4-8'))).toEqual({
      modelId: 'claude-opus-4-8',
    });
  });
});
