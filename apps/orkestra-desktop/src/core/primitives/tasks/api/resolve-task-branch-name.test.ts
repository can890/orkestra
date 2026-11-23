import { describe, expect, it } from 'vitest';
import {
  inferSemanticBranchPrefix,
  resolveTaskBranchName,
} from './resolve-task-branch-name';

describe('resolveTaskBranchName', () => {
  it('supports semantic prefixes based on task slug', () => {
    expect(inferSemanticBranchPrefix('fix-login-bug')).toBe('fix');
    expect(inferSemanticBranchPrefix('update-readme-docs')).toBe('docs');
    expect(inferSemanticBranchPrefix('add-vitest-spec')).toBe('test');
    expect(inferSemanticBranchPrefix('add-dark-mode')).toBe('feat');

    expect(
      resolveTaskBranchName({
        rawBranch: 'fix-crash-on-boot',
        branchPrefix: 'orkestra',
        branchNamingMode: 'semantic',
        suffix: 'ab12',
        appendRandomSuffix: true,
      })
    ).toBe('fix/fix-crash-on-boot-ab12');
  });

  it('keeps static and custom branch prefix modes working', () => {
    expect(
      resolveTaskBranchName({
        rawBranch: 'new-card',
        branchPrefix: 'orkestra',
        branchNamingMode: 'static',
        suffix: 'x1y2',
        appendRandomSuffix: false,
      })
    ).toBe('orkestra/new-card');

    expect(
      resolveTaskBranchName({
        rawBranch: 'new-card',
        branchPrefix: '',
        branchNamingMode: 'custom',
        branchNamingInstructions: 'team-alpha ilk harf küçük',
        suffix: 'x1y2',
        appendRandomSuffix: false,
      })
    ).toBe('team-alpha/new-card');
  });
});
