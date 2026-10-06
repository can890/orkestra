import { MAX_CONVERSATION_TITLE_LENGTH } from '@core/primitives/conversations/api';
import { REVIEW_FOCUS_AREAS, type ReviewFocus, type ReviewScope } from './review-model';

/** İnceleme konuşmalarının başlık öneki; bulgu paneli ve otomatik inceleme bununla tanır. */
export const REVIEW_TITLE_PREFIX = 'İnceleme:';

/** Kullanıcının ek talimatları için üst sınır; istemi gereksiz şişirmesin. */
export const MAX_REVIEW_INSTRUCTIONS_LENGTH = 4000;

export type ReviewPromptInput = Readonly<{
  scope: ReviewScope;
  focus: readonly ReviewFocus[];
  /** "Dal ↔ temel" kapsamı için temel ref (ör. `origin/main`); bilinmiyorsa null. */
  baseRef: string | null;
  instructions?: string | null;
}>;

export type ReviewPrompt = Readonly<{
  /** Sohbette kullanıcı mesajı olarak görünen kısa istek. */
  text: string;
  /** Ajana ayrıca giden, kendi içinde yeterli inceleme protokolü. */
  hiddenContext: string;
}>;

// Git ref adı için muhafazakâr bir kalıp: istem metnine kabuk özel karakteri sızmasın.
const SAFE_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/u;

/** Ref adı istemde güvenle kullanılabiliyorsa onu, değilse null döndürür. */
export function sanitizeBaseRef(ref: string | null | undefined): string | null {
  const trimmed = ref?.trim();
  if (!trimmed || !SAFE_REF_RE.test(trimmed)) return null;
  return trimmed;
}

const SCOPE_TITLES: Record<ReviewScope, string> = {
  uncommitted: 'commit edilmemiş değişiklikler',
  branch: 'dal ↔ temel',
  'last-commit': 'son commit',
};

/** İnceleme konuşmasının başlığı, ör. "İnceleme: son commit". */
export function reviewConversationTitle(scope: ReviewScope, baseRef?: string | null): string {
  const base = scope === 'branch' ? sanitizeBaseRef(baseRef) : null;
  const label = base ? `dal ↔ ${base}` : SCOPE_TITLES[scope];
  return `${REVIEW_TITLE_PREFIX} ${label}`.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

export function isReviewConversationTitle(title: string | null | undefined): boolean {
  return (title ?? '').trimStart().startsWith(REVIEW_TITLE_PREFIX);
}

const SCOPE_DESCRIPTIONS: Record<ReviewScope, (baseRef: string | null) => string> = {
  uncommitted: () =>
    'All uncommitted changes in the working tree: staged and unstaged modifications to tracked files, plus new untracked files.',
  branch: (baseRef) =>
    baseRef
      ? `All commits on the current branch that are not on the base \`${baseRef}\` (the diff from their merge base to HEAD). Uncommitted changes are out of scope.`
      : 'All commits on the current branch that are not on the repository default branch (the diff from their merge base to HEAD). Uncommitted changes are out of scope.',
  'last-commit': () => 'Only the most recent commit (HEAD).',
};

/** Seçilen kapsamın değişikliklerini elde etmek için ajana verilen git komutları. */
export function reviewDiffCommands(scope: ReviewScope, baseRef: string | null): string[] {
  const base = sanitizeBaseRef(baseRef);
  switch (scope) {
    case 'uncommitted':
      return ['git status --short', 'git diff HEAD', 'git ls-files --others --exclude-standard'];
    case 'branch':
      return base
        ? [
            `git log --oneline ${base}..HEAD`,
            `git diff --stat ${base}...HEAD`,
            `git diff ${base}...HEAD`,
          ]
        : [
            'git symbolic-ref --short refs/remotes/origin/HEAD',
            'git log --oneline <base>..HEAD',
            'git diff <base>...HEAD',
          ];
    case 'last-commit':
      return ['git show --stat HEAD', 'git show HEAD'];
  }
}

const FOCUS_DESCRIPTIONS: Record<ReviewFocus, string> = {
  correctness:
    'Correctness: logic errors, unhandled edge cases, broken contracts or invariants, race conditions, error handling, resource leaks, and regressions in existing behavior.',
  security:
    'Security: injection (shell, SQL, path traversal), unsafe input handling, secrets or credentials in code or logs, missing authorization, unsafe deserialization, and data exposure.',
  simplification:
    'Simplification: unnecessary complexity, duplicated logic, dead code, and places where an existing helper or a simpler construct would do.',
};

function normalizeFocus(focus: readonly ReviewFocus[]): ReviewFocus[] {
  const selected = REVIEW_FOCUS_AREAS.filter((area) => focus.includes(area));
  return selected.length > 0 ? selected : [...REVIEW_FOCUS_AREAS];
}

function normalizeInstructions(instructions: string | null | undefined): string | null {
  const trimmed = instructions?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_REVIEW_INSTRUCTIONS_LENGTH);
}

const SCOPE_SHORT: Record<ReviewScope, (baseRef: string | null) => string> = {
  uncommitted: () => 'the uncommitted changes in this worktree',
  branch: (baseRef) =>
    baseRef
      ? `the commits on this branch compared to \`${baseRef}\``
      : 'the commits on this branch',
  'last-commit': () => 'the last commit (HEAD)',
};

/**
 * Kendi içinde yeterli İngilizce inceleme istemini üretir. Görünen metin kısadır; diff'in nasıl
 * alınacağı ve katı çıktı biçimi gizli bağlamda ajana gider. Biçim, `parseReviewReport` ile
 * ayrıştırılabilecek şekilde sabittir.
 */
export function buildReviewPrompt(input: ReviewPromptInput): ReviewPrompt {
  const baseRef = input.scope === 'branch' ? sanitizeBaseRef(input.baseRef) : null;
  const focus = normalizeFocus(input.focus);
  const instructions = normalizeInstructions(input.instructions);
  const commands = reviewDiffCommands(input.scope, baseRef);

  const textLines = [`Review ${SCOPE_SHORT[input.scope](baseRef)}.`, `Focus: ${focus.join(', ')}.`];
  if (instructions) textLines.push('', `Additional instructions: ${instructions}`);

  const sections: string[] = [
    [
      'You are acting as a code reviewer for changes in this Git worktree (your current working directory).',
      'This is a read-only review: do NOT edit, create, or delete files, and do NOT stage, commit, stash, reset, checkout, or run any command that changes the repository or its working tree.',
    ].join('\n'),
    [
      '## What to review',
      `Scope: ${SCOPE_DESCRIPTIONS[input.scope](baseRef)}`,
      '',
      'Obtain the changes with:',
      ...commands.map((command) => `    ${command}`),
      ...(input.scope === 'uncommitted'
        ? [
            '',
            'Read the full contents of any new untracked files listed above. If the repository has no commits yet, use `git diff --cached` and `git diff` instead of `git diff HEAD`.',
          ]
        : []),
      ...(input.scope === 'branch' && !baseRef
        ? [
            '',
            'Replace <base> with the default branch reported by the first command (for example `origin/main`); if it fails, use `origin/main`, `origin/master`, `main`, or `master`, whichever exists.',
          ]
        : []),
      '',
      'Read the surrounding code as needed (callers, callees, tests, types) to judge the changes. Review only the changes in scope; mention a pre-existing problem only if the change introduces, exposes, or worsens it.',
    ].join('\n'),
    ['## Focus', ...focus.map((area) => `- ${FOCUS_DESCRIPTIONS[area]}`)].join('\n'),
  ];
  if (instructions) {
    sections.push(['## Additional instructions from the user', instructions].join('\n'));
  }
  sections.push(
    [
      '## Output format (strict)',
      'When your investigation is complete, end your reply with exactly the structure below so it can be parsed automatically. Write one block per finding, ordered from most to least severe:',
      '',
      'FINDING 1',
      'Severity: critical | high | medium | low',
      'Location: relative/path/to/file.ext:LINE',
      'Summary: <one sentence describing the problem>',
      'Failure scenario: <concrete inputs or conditions and what goes wrong>',
      'Suggested fix: <the specific change to make>',
      '',
      'FINDING 2',
      '...',
      '',
      'If there are no findings, write this single line instead of the blocks:',
      'NO FINDINGS',
      '',
      'Then finish with:',
      'VERDICT: approve | comment | request-changes',
      'Rationale: <one or two sentences>',
      '',
      'Rules:',
      "- Location is a path relative to the repository root plus the 1-based line number in the current version of the file (the first line of the relevant range). Use the deleted line's nearest surviving neighbor for removed code.",
      '- Severity: critical = security hole, data loss, or crash on a common path; high = incorrect behavior that users are likely to hit; medium = edge-case bug or significant maintainability risk; low = minor issue or nit.',
      '- Report only real, actionable problems and do not pad the list. Do not use tables. Put each field on its own line; a field may continue on the following lines.',
      '- Verdict: approve = no blocking problems; comment = only non-blocking findings; request-changes = at least one finding should be fixed before merging.',
    ].join('\n')
  );

  return { text: textLines.join('\n'), hiddenContext: sections.join('\n\n') };
}
