import { describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  isReviewConversationTitle,
  reviewConversationTitle,
  reviewDiffCommands,
  sanitizeBaseRef,
} from './review-prompt';

describe('reviewDiffCommands', () => {
  it('reviews staged, unstaged and untracked changes for the uncommitted scope', () => {
    expect(reviewDiffCommands('uncommitted', null)).toEqual([
      'git status --short',
      'git diff HEAD',
      'git ls-files --others --exclude-standard',
    ]);
  });

  it('diffs from the merge base for the branch scope', () => {
    expect(reviewDiffCommands('branch', 'origin/main')).toEqual([
      'git log --oneline origin/main..HEAD',
      'git diff --stat origin/main...HEAD',
      'git diff origin/main...HEAD',
    ]);
  });

  it('asks the agent to discover the default branch when the base is unknown', () => {
    const commands = reviewDiffCommands('branch', null);
    expect(commands[0]).toBe('git symbolic-ref --short refs/remotes/origin/HEAD');
    expect(commands).toContain('git diff <base>...HEAD');
  });

  it('shows only HEAD for the last-commit scope', () => {
    expect(reviewDiffCommands('last-commit', 'origin/main')).toEqual([
      'git show --stat HEAD',
      'git show HEAD',
    ]);
  });

  it('never interpolates an unsafe base ref', () => {
    expect(reviewDiffCommands('branch', 'main; rm -rf /')).toContain('git diff <base>...HEAD');
    expect(sanitizeBaseRef('--output=/tmp/x')).toBeNull();
    expect(sanitizeBaseRef('origin/feature..main')).toBeNull();
    expect(sanitizeBaseRef('  origin/release-1.2  ')).toBe('origin/release-1.2');
  });
});

describe('buildReviewPrompt', () => {
  it('builds a self-contained, read-only prompt with the strict output format', () => {
    const prompt = buildReviewPrompt({
      scope: 'uncommitted',
      focus: ['correctness'],
      baseRef: 'origin/main',
    });
    expect(prompt.text).toBe(
      'Review the uncommitted changes in this worktree.\nFocus: correctness.'
    );
    expect(prompt.hiddenContext).toContain('do NOT edit, create, or delete files');
    expect(prompt.hiddenContext).toContain('    git diff HEAD');
    expect(prompt.hiddenContext).toContain('git ls-files --others --exclude-standard');
    expect(prompt.hiddenContext).toContain('FINDING 1\nSeverity: critical | high | medium | low');
    expect(prompt.hiddenContext).toContain('NO FINDINGS');
    expect(prompt.hiddenContext).toContain('VERDICT: approve | comment | request-changes');
    // Dal kapsamı dışındaki temel ref istemde yer almaz.
    expect(prompt.hiddenContext).not.toContain('origin/main');
    expect(prompt.hiddenContext).toContain('- Correctness:');
    expect(prompt.hiddenContext).not.toContain('- Security:');
  });

  it('names the base ref for the branch scope', () => {
    const prompt = buildReviewPrompt({
      scope: 'branch',
      focus: ['security'],
      baseRef: 'origin/main',
    });
    expect(prompt.text).toContain('compared to `origin/main`');
    expect(prompt.hiddenContext).toContain('not on the base `origin/main`');
    expect(prompt.hiddenContext).toContain('    git diff origin/main...HEAD');
    expect(prompt.hiddenContext).toContain('Uncommitted changes are out of scope.');
  });

  it('explains how to find the base when it is unknown', () => {
    const prompt = buildReviewPrompt({ scope: 'branch', focus: [], baseRef: null });
    expect(prompt.hiddenContext).toContain('Replace <base> with the default branch');
  });

  it('describes the last commit scope', () => {
    const prompt = buildReviewPrompt({
      scope: 'last-commit',
      focus: ['simplification'],
      baseRef: null,
    });
    expect(prompt.text).toContain('the last commit (HEAD)');
    expect(prompt.hiddenContext).toContain('    git show HEAD');
  });

  it('falls back to every focus area when none is selected', () => {
    const prompt = buildReviewPrompt({ scope: 'last-commit', focus: [], baseRef: null });
    expect(prompt.text).toContain('Focus: correctness, security, simplification.');
  });

  it('includes trimmed extra instructions in both parts', () => {
    const prompt = buildReviewPrompt({
      scope: 'uncommitted',
      focus: ['correctness', 'security'],
      baseRef: null,
      instructions: '  Pay attention to the SSH escaping.  ',
    });
    expect(prompt.text).toContain('Additional instructions: Pay attention to the SSH escaping.');
    expect(prompt.hiddenContext).toContain(
      '## Additional instructions from the user\nPay attention to the SSH escaping.'
    );
  });
});

describe('review conversation titles', () => {
  it('prefixes titles so review conversations can be recognized', () => {
    expect(reviewConversationTitle('uncommitted')).toBe('İnceleme: commit edilmemiş değişiklikler');
    expect(reviewConversationTitle('branch', 'origin/main')).toBe('İnceleme: dal ↔ origin/main');
    expect(reviewConversationTitle('branch', null)).toBe('İnceleme: dal ↔ temel');
    expect(reviewConversationTitle('last-commit')).toBe('İnceleme: son commit');
    expect(isReviewConversationTitle('İnceleme: son commit')).toBe(true);
    expect(isReviewConversationTitle('Claude 2')).toBe(false);
  });
});
