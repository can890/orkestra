import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOOK_TIMEOUT_SEC,
  emptyLifecycleHooksConfig,
  lifecycleHooksConfig,
  validateLifecycleHooksConfig,
  type HookDefinition,
} from './hook-config';

const hook = (overrides: Partial<HookDefinition> = {}): HookDefinition => ({
  id: 'h1',
  name: 'Bildirim',
  event: 'task.created',
  command: 'echo merhaba',
  enabled: true,
  timeoutSec: DEFAULT_HOOK_TIMEOUT_SEC,
  projectIds: [],
  ...overrides,
});

const config = (hooks: HookDefinition[], paused = false) => ({ version: '1', paused, hooks });

describe('kanca yapılandırması', () => {
  it('varsayılan olarak hiçbir kanca tanımlı gelmez ve duraklatılmamıştır', () => {
    expect(emptyLifecycleHooksConfig()).toEqual({ version: '1', paused: false, hooks: [] });
  });

  it('geçerli yapılandırmayı kabul eder', () => {
    const result = validateLifecycleHooksConfig(config([hook(), hook({ id: 'h2' })]));
    expect(result.success).toBe(true);
  });

  it('bilinmeyen olay türünü reddeder', () => {
    const result = validateLifecycleHooksConfig(config([hook({ event: 'task.deleted' as never })]));
    expect(result.success).toBe(false);
  });

  it('boş komutu, NUL içeren komutu ve aşırı uzun komutu reddeder', () => {
    expect(validateLifecycleHooksConfig(config([hook({ command: '   ' })])).success).toBe(false);
    expect(validateLifecycleHooksConfig(config([hook({ command: 'a\0b' })])).success).toBe(false);
    expect(validateLifecycleHooksConfig(config([hook({ command: 'x'.repeat(4001) })])).success).toBe(
      false
    );
  });

  it('zaman aşımını 1..300 sn aralığıyla sınırlar', () => {
    expect(validateLifecycleHooksConfig(config([hook({ timeoutSec: 0 })])).success).toBe(false);
    expect(validateLifecycleHooksConfig(config([hook({ timeoutSec: 301 })])).success).toBe(false);
    expect(validateLifecycleHooksConfig(config([hook({ timeoutSec: 1.5 })])).success).toBe(false);
    expect(validateLifecycleHooksConfig(config([hook({ timeoutSec: 300 })])).success).toBe(true);
  });

  it('yinelenen kanca kimliğini reddeder', () => {
    const result = validateLifecycleHooksConfig(config([hook(), hook()]));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Yinelenen');
  });

  it('kimlikte env/yol karakterlerine izin vermez', () => {
    expect(validateLifecycleHooksConfig(config([hook({ id: '../x' })])).success).toBe(false);
    expect(validateLifecycleHooksConfig(config([hook({ id: 'a b' })])).success).toBe(false);
  });

  it('en fazla 50 kancaya izin verir', () => {
    const many = Array.from({ length: 51 }, (_, i) => hook({ id: `h${i}` }));
    expect(validateLifecycleHooksConfig(config(many)).success).toBe(false);
  });

  it('bilinmeyen alanları ayıklar (komut dışı veri taşınmaz)', () => {
    const result = validateLifecycleHooksConfig({
      ...config([{ ...hook(), extra: 'x' } as never]),
      stray: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config).not.toHaveProperty('stray');
      expect(result.config.hooks[0]).not.toHaveProperty('extra');
    }
  });

  it('sürümlü şema geçerli veriyi okur, bilinmeyen sürümü future-version sayar', () => {
    expect(lifecycleHooksConfig.safeParse(config([hook()])).status).toBe('ok');
    expect(lifecycleHooksConfig.safeParse({ version: '9', paused: false, hooks: [] }).status).toBe(
      'future-version'
    );
  });
});
