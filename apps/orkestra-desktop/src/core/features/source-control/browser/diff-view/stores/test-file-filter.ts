/**
 * Test file path matcher for Diff View "Hide Test Files" toggle (Feature #8).
 * Adapted from T3 Code (MIT License) useHideTestFiles.ts.
 */

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:__tests__|__mocks__|__snapshots__|tests?|spec|specs|e2e)\//i,
  /\.(?:test|spec|e2e|stories|story|cy)\.[^./]+$/i,
  /_(?:test|spec)\.[^./]+$/i,
  /(?:^|\/)test_[^/]+\.py$/i,
  /(?:^|\/)[A-Za-z0-9_]+(?:Test|Tests|Spec)\.(?:java|kt|swift|cs|rb|php)$/i,
];

export function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_PATH_PATTERNS.some((re) => re.test(normalized));
}
