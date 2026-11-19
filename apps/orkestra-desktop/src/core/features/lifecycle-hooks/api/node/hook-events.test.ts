import { describe, expect, it } from 'vitest';
import type { HookDefinition, LifecycleHooksConfig } from '../hook-config';
import { matchHooks } from './hook-events';

const hook = (overrides: Partial<HookDefinition>): HookDefinition => ({
  id: 'h',
  name: '',
  event: 'task.created',
  command: 'true',
  enabled: true,
  timeoutSec: 30,
  projectIds: [],
  ...overrides,
});
const cfg = (hooks: HookDefinition[], paused = false): LifecycleHooksConfig => ({
  version: '1',
  paused,
  hooks,
});

describe('matchHooks', () => {
  const event = { name: 'task.created', projectId: 'p1' } as const;

  it('olay türüne göre eşler', () => {
    const result = matchHooks(
      cfg([hook({ id: 'a' }), hook({ id: 'b', event: 'task.archived' })]),
      event
    );
    expect(result.map((h) => h.id)).toEqual(['a']);
  });

  it('proje süzgecini uygular; boş süzgeç tüm projeleri kapsar', () => {
    const result = matchHooks(
      cfg([
        hook({ id: 'all' }),
        hook({ id: 'mine', projectIds: ['p1', 'p2'] }),
        hook({ id: 'other', projectIds: ['p9'] }),
      ]),
      event
    );
    expect(result.map((h) => h.id)).toEqual(['all', 'mine']);
  });

  it('devre dışı kancayı atlar', () => {
    expect(matchHooks(cfg([hook({ enabled: false })]), event)).toEqual([]);
  });

  it('"tümünü duraklat" açıkken hiçbir kanca eşlenmez', () => {
    expect(matchHooks(cfg([hook({})], true), event)).toEqual([]);
  });
});
