import { describe, expect, it } from 'vitest';
import { buildHeuristicReviewGuide, classifyReviewFile, parseLlmReviewGuide } from './review-guide';

describe('review-guide', () => {
  it('classifies files and orders steps contracts -> core -> ui -> tests -> config', () => {
    expect(classifyReviewFile('src/features/auth/api/contract.ts')).toBe('contracts');
    expect(classifyReviewFile('src/features/auth/node/auth-service.ts')).toBe('core');
    expect(classifyReviewFile('src/features/auth/browser/LoginForm.tsx')).toBe('ui');
    expect(classifyReviewFile('src/features/auth/node/auth-service.test.ts')).toBe('tests');
    expect(classifyReviewFile('docs/readme.md')).toBe('config');

    const guide = buildHeuristicReviewGuide([
      { path: 'src/features/auth/browser/LoginForm.tsx', additions: 10 },
      { path: 'src/features/auth/node/auth-service.test.ts', additions: 25 },
      { path: 'src/features/auth/api/contract.ts', additions: 12 },
      { path: 'package.json', additions: 2 },
      { path: 'src/features/auth/node/auth-service.ts', additions: 40 },
    ]);

    expect(guide.source).toBe('heuristic');
    expect(guide.totalFiles).toBe(5);
    expect(guide.steps.map((step) => step.category)).toEqual([
      'contracts',
      'core',
      'ui',
      'tests',
      'config',
    ]);
    expect(guide.steps[0]?.riskLevel).toBe('high');
  });

  it('parses fenced LLM review guide JSON and preserves uncovered fallback files', () => {
    const raw = `\`\`\`json
    {
      "summary": "Önce API sözleşmesi sonra UI kontrol edilmeli.",
      "steps": [
        {
          "category": "contracts",
          "title": "API Sözleşmesi",
          "summary": "Yeni alan eklendi.",
          "files": ["src/api/contract.ts"],
          "riskLevel": "high"
        }
      ]
    }
    \`\`\``;
    const guide = parseLlmReviewGuide(raw, ['src/api/contract.ts', 'src/ui/Card.tsx']);
    expect(guide).not.toBeNull();
    expect(guide?.source).toBe('llm');
    expect(guide?.steps).toHaveLength(2);
    expect(guide?.steps[1]?.files).toEqual(['src/ui/Card.tsx']);

    expect(parseLlmReviewGuide('invalid json', ['a.ts'])).toBeNull();
  });
});
