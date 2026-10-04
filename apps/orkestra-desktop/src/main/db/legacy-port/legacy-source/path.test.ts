import { describe, expect, it } from 'vitest';
import { resolveLegacyUserDataPathCandidates } from './path';

describe('resolveLegacyUserDataPathCandidates', () => {
  it('checks the capitalized legacy config directory after lowercase orkestra on Linux', () => {
    expect(resolveLegacyUserDataPathCandidates('/home/user/.config/orkestra', 'linux')).toEqual([
      '/home/user/.config/orkestra',
      '/home/user/.config/Orkestra',
    ]);
  });

  it('does not add a capitalized fallback outside Linux', () => {
    expect(
      resolveLegacyUserDataPathCandidates(
        '/Users/user/Library/Application Support/orkestra',
        'darwin'
      )
    ).toEqual(['/Users/user/Library/Application Support/orkestra']);
  });

  it('does not duplicate paths when the configured directory is already capitalized', () => {
    expect(resolveLegacyUserDataPathCandidates('/home/user/.config/Orkestra', 'linux')).toEqual([
      '/home/user/.config/Orkestra',
    ]);
  });
});
