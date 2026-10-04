import { describe, expect, it } from 'vitest';
import { normalizeBranchPrefix } from './branch-prefix';

describe('normalizeBranchPrefix', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBranchPrefix('orkestra/')).toBe('orkestra');
    expect(normalizeBranchPrefix('orkestra///')).toBe('orkestra');
  });

  it('strips leading slashes', () => {
    expect(normalizeBranchPrefix('/orkestra')).toBe('orkestra');
    expect(normalizeBranchPrefix('///orkestra')).toBe('orkestra');
    expect(normalizeBranchPrefix('/team/orkestra/')).toBe('team/orkestra');
  });

  it('trims whitespace', () => {
    expect(normalizeBranchPrefix('  orkestra/  ')).toBe('orkestra');
  });

  it('preserves internal slashes', () => {
    expect(normalizeBranchPrefix('team/orkestra')).toBe('team/orkestra');
  });

  it('leaves valid prefixes unchanged', () => {
    expect(normalizeBranchPrefix('orkestra')).toBe('orkestra');
    expect(normalizeBranchPrefix('')).toBe('');
  });
});
