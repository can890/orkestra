import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_MAC_SIGNING_IDENTITY,
  resolveLocalMacSigningIdentity,
} from './local-mac-signing';

const WITH_SOVRA_CERT =
  '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Sovra Local Signing"\n     1 valid identities found\n';

describe('resolveLocalMacSigningIdentity', () => {
  it('returns the local signing identity when present in macOS keychain', () => {
    expect(resolveLocalMacSigningIdentity({}, 'darwin', () => WITH_SOVRA_CERT)).toBe(
      DEFAULT_LOCAL_MAC_SIGNING_IDENTITY
    );
  });

  it('returns undefined when no matching certificate exists or lookup fails', () => {
    expect(
      resolveLocalMacSigningIdentity({}, 'darwin', () => '     0 valid identities found\n')
    ).toBeUndefined();
    expect(
      resolveLocalMacSigningIdentity({}, 'darwin', () => {
        throw new Error('security unavailable');
      })
    ).toBeUndefined();
  });

  it('defers to explicit CSC settings, CI, or non-macOS platforms', () => {
    expect(resolveLocalMacSigningIdentity({}, 'linux', () => WITH_SOVRA_CERT)).toBeUndefined();
    expect(
      resolveLocalMacSigningIdentity({ CI: 'true' }, 'darwin', () => WITH_SOVRA_CERT)
    ).toBeUndefined();
    expect(
      resolveLocalMacSigningIdentity({ CSC_NAME: 'Developer ID' }, 'darwin', () => WITH_SOVRA_CERT)
    ).toBeUndefined();
    expect(
      resolveLocalMacSigningIdentity({ CSC_LINK: 'base64-cert' }, 'darwin', () => WITH_SOVRA_CERT)
    ).toBeUndefined();
    expect(
      resolveLocalMacSigningIdentity(
        { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        'darwin',
        () => WITH_SOVRA_CERT
      )
    ).toBeUndefined();
  });
});
