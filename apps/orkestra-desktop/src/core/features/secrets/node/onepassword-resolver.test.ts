import { describe, expect, it, vi } from 'vitest';
import { isOpReference, OnePasswordResolver } from './onepassword-resolver';

describe('OnePasswordResolver', () => {
  it('detects op:// references accurately', () => {
    expect(isOpReference('op://Private/OpenAI/api_key')).toBe(true);
    expect(isOpReference('  op://Vault/Item/field ')).toBe(true);
    expect(isOpReference('sk-123456')).toBe(false);
  });

  it('skips op CLI entirely when disabled or no op:// env vars exist', async () => {
    const runOp = vi.fn();
    const resolver = new OnePasswordResolver(runOp);

    const disabledOut = await resolver.resolveEnvSecrets(
      { API_KEY: 'op://Private/OpenAI/key' },
      { enabled: false }
    );
    expect(disabledOut.API_KEY).toBe('op://Private/OpenAI/key');
    expect(runOp).not.toHaveBeenCalled();

    const noRefOut = await resolver.resolveEnvSecrets({ NORMAL_VAR: 'hello' }, { enabled: true });
    expect(noRefOut.NORMAL_VAR).toBe('hello');
    expect(runOp).not.toHaveBeenCalled();
  });

  it('resolves and caches op:// env values with TTL and leaves failed refs intact', async () => {
    const runOp = vi.fn(async (args: string[]) => {
      if (args.includes('op://Vault/Ok/token')) {
        return { stdout: 'resolved-secret-value', stderr: '' };
      }
      throw new Error('item not found');
    });
    const resolver = new OnePasswordResolver(runOp);
    const warn = vi.fn();

    const first = await resolver.resolveEnvSecrets(
      {
        GOOD_KEY: 'op://Vault/Ok/token',
        BAD_KEY: 'op://Vault/Missing/token',
        PLAIN: 'plain',
      },
      { enabled: true, account: 'work.1password.com', warn }
    );

    expect(first).toEqual({
      GOOD_KEY: 'resolved-secret-value',
      BAD_KEY: 'op://Vault/Missing/token',
      PLAIN: 'plain',
    });
    expect(warn).toHaveBeenCalledTimes(1);

    // Cache hit on GOOD_KEY
    await resolver.resolveEnvSecrets(
      { GOOD_KEY: 'op://Vault/Ok/token' },
      { enabled: true, account: 'work.1password.com' }
    );
    expect(runOp).toHaveBeenCalledTimes(2);
  });

  it('masks preview output without returning raw secret', async () => {
    const resolver = new OnePasswordResolver(async () => ({
      stdout: 'sk-super-secret-value',
      stderr: '',
    }));
    const preview = await resolver.resolvePreview('op://Vault/OpenAI/key');
    expect(preview.ok).toBe(true);
    expect(preview.maskedPreview).not.toContain('super-secret');
    expect(preview.maskedPreview?.startsWith('sk')).toBe(true);
  });
});
