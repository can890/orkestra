import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acpRegistrySearchRank,
  AcpRegistryParseError,
  parseAcpRegistryIndex,
} from '../api/registry-schema';

// Gerçek dizinin (cdn.agentclientprotocol.com/registry/v1/latest/registry.json) kırpılmış kopyası
// ve iki bilinçli bozuk kayıt; testler ağa çıkmaz.
const fixtureText = readFileSync(join(__dirname, 'fixtures/registry-index.fixture.json'), 'utf8');

describe('parseAcpRegistryIndex', () => {
  it('parses the real index shape and skips invalid entries', () => {
    const index = parseAcpRegistryIndex(fixtureText);
    expect(index.version).toBe('1.0.0');
    expect(index.discarded).toBe(2);
    expect(index.agents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining(['amp-acp', 'gemini', 'fast-agent', 'devin', 'claude-acp'])
    );
    expect(index.agents.find((agent) => agent.id === 'unpinned')).toBeUndefined();
    const amp = index.agents.find((agent) => agent.id === 'amp-acp')!;
    expect(amp.distribution.binary?.['darwin-aarch64']).toMatchObject({
      cmd: './amp-acp',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const fast = index.agents.find((agent) => agent.id === 'fast-agent')!;
    expect(fast.distribution.uvx).toMatchObject({
      package: 'fast-agent-acp==0.10.66',
      env: { FAST_AGENT_MODEL: 'codexplan' },
    });
  });

  it('rejects a malformed envelope', () => {
    expect(() => parseAcpRegistryIndex('nope')).toThrow(AcpRegistryParseError);
    expect(() => parseAcpRegistryIndex(JSON.stringify({ agents: [] }))).toThrow(
      AcpRegistryParseError
    );
  });

  it('drops agents with insecure or credentialed URLs and unsafe versions', () => {
    const base = {
      id: 'x',
      name: 'X',
      version: '1.0.0',
      description: '',
      distribution: { npx: { package: 'x@1.0.0' } },
    };
    const index = parseAcpRegistryIndex(
      JSON.stringify({
        version: '1.0.0',
        agents: [
          { ...base, id: 'ok' },
          { ...base, id: 'http-icon', icon: 'http://example.com/a.svg' },
          { ...base, id: 'cred', repository: 'https://user:pw@example.com/x' },
          { ...base, id: 'dots', version: '..' },
          {
            ...base,
            id: 'http-archive',
            distribution: {
              binary: { 'darwin-aarch64': { archive: 'http://example.com/x.tgz', cmd: 'x' } },
            },
          },
        ],
      })
    );
    expect(index.agents.map((agent) => agent.id)).toEqual(['ok']);
    expect(index.discarded).toBe(4);
  });
});

describe('acpRegistrySearchRank', () => {
  const agents = parseAcpRegistryIndex(fixtureText).agents;
  const rank = (id: string, query: string) =>
    acpRegistrySearchRank(agents.find((agent) => agent.id === id)!, query);

  it('ranks exact, prefix, token and description matches', () => {
    expect(rank('gemini', 'gemini')).toBe(0);
    expect(rank('gemini', 'gem')).toBe(10);
    expect(rank('fast-agent', 'agent')).toBe(20);
    expect(rank('gemini', 'google')).toBe(40);
    expect(rank('gemini', 'zzz-not-there')).toBeUndefined();
    expect(rank('gemini', '')).toBe(100);
  });
});
