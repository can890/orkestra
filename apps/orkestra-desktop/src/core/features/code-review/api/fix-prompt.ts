import { severityRank, type ReviewFinding } from './review-model';

export type FixPromptOptions = Readonly<{
  /** İstemin gönderildiği konuşma inceleyicinin kendisi mi (o zaman salt-okuma kuralı kalkar). */
  target: 'main' | 'reviewer';
  /** İnceleme konuşmasının başlığı; bağlam olarak eklenir. */
  reviewTitle?: string | null;
}>;

function formatLocation(finding: ReviewFinding): string {
  if (!finding.file) return finding.location ?? 'unknown location';
  if (finding.line === null) return finding.file;
  return finding.endLine
    ? `${finding.file}:${finding.line}-${finding.endLine}`
    : `${finding.file}:${finding.line}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n')
    .trimStart();
}

/** Seçilen bulguların düzeltilmesini isteyen İngilizce istemi üretir. */
export function buildFixPrompt(
  findings: readonly ReviewFinding[],
  options: FixPromptOptions
): string {
  const ordered = [...findings].sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) || left.index - right.index
  );
  const intro =
    options.target === 'reviewer'
      ? 'Please fix the following findings from your review. You may now edit files in this worktree; the earlier read-only restriction no longer applies.'
      : `A code review of the current changes in this worktree${options.reviewTitle ? ` ("${options.reviewTitle}")` : ''} reported the findings below. Please fix them.`;
  const items = ordered.map((finding, position) => {
    const lines = [
      `${position + 1}. [${finding.severity.toUpperCase()}] ${formatLocation(finding)} — ${finding.summary}`,
    ];
    if (finding.failureScenario) {
      lines.push(`   Failure scenario: ${indent(finding.failureScenario)}`);
    }
    if (finding.suggestedFix) lines.push(`   Suggested fix: ${indent(finding.suggestedFix)}`);
    return lines.join('\n');
  });
  return [
    intro,
    '',
    ...items,
    '',
    'Guidelines:',
    '- First confirm each finding against the code. If one is not a real problem, do not change code for it; explain why briefly.',
    '- Keep the changes minimal and focused on these findings; do not refactor unrelated code.',
    '- Run the relevant tests or type checks if the project has them.',
    '- Finish with a short summary of what you changed for each finding.',
  ].join('\n');
}
