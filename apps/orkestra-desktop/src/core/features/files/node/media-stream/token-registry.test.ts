import { describe, expect, it } from 'vitest';
import { MediaTokenRegistry } from './token-registry';

describe('MediaTokenRegistry', () => {
  it('mints unguessable 256-bit tokens that resolve to their target', () => {
    const registry = new MediaTokenRegistry<string>();
    const first = registry.mint('a');
    const second = registry.mint('b');
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(registry.resolve(first)).toBe('a');
    expect(registry.resolve(second)).toBe('b');
  });

  it('rejects forged, malformed and released tokens', () => {
    const registry = new MediaTokenRegistry<string>();
    const token = registry.mint('video');
    const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(registry.resolve(forged)).toBeUndefined();
    expect(registry.resolve('../../etc/passwd')).toBeUndefined();
    expect(registry.resolve('')).toBeUndefined();
    expect(registry.resolve(`${token}x`)).toBeUndefined();
    registry.release(token);
    expect(registry.resolve(token)).toBeUndefined();
  });

  it('expires idle tokens and refreshes on use', () => {
    let now = 0;
    const registry = new MediaTokenRegistry<string>({ idleTtlMs: 1000, now: () => now });
    const kept = registry.mint('kept');
    const idle = registry.mint('idle');
    now = 900;
    expect(registry.resolve(kept)).toBe('kept');
    now = 1500;
    expect(registry.resolve(kept)).toBe('kept');
    expect(registry.resolve(idle)).toBeUndefined();
    now = 2600;
    expect(registry.resolve(kept)).toBeUndefined();
  });

  it('evicts the least recently used token beyond its capacity', () => {
    const registry = new MediaTokenRegistry<number>({ maxEntries: 2 });
    const one = registry.mint(1);
    const two = registry.mint(2);
    registry.resolve(one);
    const three = registry.mint(3);
    expect(registry.size).toBe(2);
    expect(registry.resolve(two)).toBeUndefined();
    expect(registry.resolve(one)).toBe(1);
    expect(registry.resolve(three)).toBe(3);
  });
});
