import type { BranchNamingMode } from '@core/primitives/app-settings/api';
import type { LinkedIssue } from '@core/primitives/linked-issues/api';

type ResolveTaskBranchNameInput = {
  rawBranch: string;
  branchPrefix: string;
  branchNamingMode?: BranchNamingMode;
  branchNamingInstructions?: string;
  suffix: string;
  appendRandomSuffix: boolean;
  linkedIssue?: LinkedIssue;
  disableRandomSuffix?: boolean;
};

export function inferSemanticBranchPrefix(rawBranch: string): string {
  const lower = rawBranch.toLowerCase();
  if (/(?:^|[-_\s])(fix|bug|hotfix|hata|duzelt|düzelt)(?:$|[-_\s])/.test(lower)) return 'fix';
  if (/(?:^|[-_\s])(docs?|readme|rehber|belge)(?:$|[-_\s])/.test(lower)) return 'docs';
  if (/(?:^|[-_\s])(test|spec|vitest|e2e)(?:$|[-_\s])/.test(lower)) return 'test';
  if (/(?:^|[-_\s])(refactor|cleanup|temiz|duzenle)(?:$|[-_\s])/.test(lower)) return 'refactor';
  if (/(?:^|[-_\s])(chore|bump|deps|build|ci)(?:$|[-_\s])/.test(lower)) return 'chore';
  return 'feat';
}

function customInstructionPrefix(instructions: string | undefined, fallbackPrefix: string): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return fallbackPrefix;
  // Kullanıcı özel ön ek kalıbı verdiyse (ör. `prefix: team/` veya tek token `wip/team`) güvenli slug çıkar.
  const token = trimmed
    .split(/\s+/)[0]
    ?.replace(/[^A-Za-z0-9/_-]/g, '')
    .replace(/^\/+|\/+$/g, '');
  if (token && token.length <= 24) return token;
  return fallbackPrefix;
}

export function resolveTaskBranchName({
  rawBranch,
  branchPrefix,
  branchNamingMode = 'static',
  branchNamingInstructions,
  suffix,
  appendRandomSuffix,
  linkedIssue,
  disableRandomSuffix = false,
}: ResolveTaskBranchNameInput): string {
  const linearBranchName =
    linkedIssue?.provider === 'linear' ? linkedIssue.branchName?.trim() : undefined;

  if (linearBranchName) {
    return linearBranchName;
  }

  const shouldAppendSuffix =
    appendRandomSuffix && !disableRandomSuffix && linkedIssue?.provider !== 'linear';
  const branch = shouldAppendSuffix ? `${rawBranch}-${suffix}` : rawBranch;

  if (branchNamingMode === 'semantic') {
    const semantic = inferSemanticBranchPrefix(rawBranch);
    return `${semantic}/${branch}`;
  }
  if (branchNamingMode === 'custom') {
    const effectivePrefix = branchPrefix || customInstructionPrefix(branchNamingInstructions, '');
    return effectivePrefix ? `${effectivePrefix}/${branch}` : branch;
  }
  return branchPrefix ? `${branchPrefix}/${branch}` : branch;
}
