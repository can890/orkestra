import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationIdRegime } from '../../api/schemas';
import { parseProviderLinkPayload, serializeProviderLinkPayload } from './payload-codecs';

function storedProviderLink(idRegime: string): string {
  return JSON.stringify({
    version: '1',
    providerSessionId: 'session-1',
    idRegime,
    observedAt: 1_500,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('conversation provider-link payloads', () => {
  it('reads the emdash-chosen regime written before the Orkestra rename as orkestra-chosen', () => {
    expect(parseProviderLinkPayload(storedProviderLink('emdash-chosen'))).toEqual({
      providerSessionId: 'session-1',
      idRegime: 'orkestra-chosen',
      observedAt: 1_500,
    });
  });

  it('maps the legacy regime even when production skips stored-payload validation', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(parseProviderLinkPayload(storedProviderLink('emdash-chosen')).idRegime).toBe(
      'orkestra-chosen'
    );
  });

  it.each<ConversationIdRegime>(['orkestra-chosen', 'provider-minted', 'none'])(
    'round-trips the %s regime unchanged',
    (idRegime) => {
      const link = { providerSessionId: null, idRegime, observedAt: null };

      expect(parseProviderLinkPayload(serializeProviderLinkPayload(link))).toEqual(link);
    }
  );

  it('still rejects regimes that never existed', () => {
    expect(() => parseProviderLinkPayload(storedProviderLink('someone-chosen'))).toThrow(
      'Unable to parse stored provider link'
    );
  });
});
