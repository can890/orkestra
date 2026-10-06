import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serializeForAgent } from './evaluate-script';
import { buildPageScript, pageAgent } from './page-script';

describe('injected script sources', () => {
  it('compile as standalone scripts without bundler helpers', () => {
    for (const source of [pageAgent.toString(), serializeForAgent.toString()]) {
      expect(source).not.toMatch(/__name\(|__publicField|__async|require\(|import\(/);
    }
    const script = buildPageScript({ kind: 'metrics' });
    expect(() => new Script(script)).not.toThrow();
    expect(script.endsWith('{"kind":"metrics"})')).toBe(true);
  });
});
