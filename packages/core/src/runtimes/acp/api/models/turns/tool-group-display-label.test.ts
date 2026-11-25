import { describe, expect, it } from 'vitest';
import { toolGroupDisplayLabel as toolGroupLabel } from './tool-group-display-label';

const of = (...kinds: string[]) => kinds.map((kind) => ({ kind }) as { kind: never });

describe('toolGroupLabel', () => {
  it('summarises every kind in Turkish with singular and plural forms', () => {
    expect(toolGroupLabel(of('execute-tool-call'))).toBe('Bir komut çalıştırıldı');
    expect(toolGroupLabel(of('execute-tool-call', 'execute-tool-call'))).toBe(
      '2 komut çalıştırıldı'
    );
    expect(toolGroupLabel(of('read-tool-call', 'read-tool-call'))).toBe('2 dosya okundu');
    expect(toolGroupLabel(of('search-tool-call', 'search-tool-call'))).toBe('2 arama yapıldı');
    expect(toolGroupLabel(of('mcp-tool-call', 'web-fetch-tool-call'))).toBe('2 araç kullanıldı');
  });

  it('joins mixed runs in a fixed order and capitalises only the first part', () => {
    expect(
      toolGroupLabel(
        of(
          'search-tool-call',
          'execute-tool-call',
          'read-tool-call',
          'unknown-tool-call',
          'execute-tool-call'
        )
      )
    ).toBe('2 komut çalıştırıldı, bir dosya okundu, bir arama yapıldı, bir araç kullanıldı');
    expect(toolGroupLabel(of('read-tool-call', 'mcp-tool-call'))).toBe(
      'Bir dosya okundu, bir araç kullanıldı'
    );
  });

  it('never leaves English fragments', () => {
    const label = toolGroupLabel(
      of('execute-tool-call', 'read-tool-call', 'search-tool-call', 'mcp-tool-call')
    );
    expect(label).not.toMatch(/\b(?:ran|read|used|command|file|search|tool)s?\b/i);
  });
});
