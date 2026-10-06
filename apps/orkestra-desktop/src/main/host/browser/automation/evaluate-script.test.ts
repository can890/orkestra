import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { decodeEvaluationResult, prepareEvaluation, serializeForAgent } from './evaluate-script';

async function evaluateInVm(code: string, maxChars?: number): Promise<unknown> {
  const prepared = prepareEvaluation(code, maxChars);
  const raw: unknown = await runInNewContext(prepared.source, { setTimeout });
  return decodeEvaluationResult(raw, maxChars);
}

describe('prepareEvaluation', () => {
  it('uses the expression form when possible and strips trailing semicolons', () => {
    expect(prepareEvaluation('document.title;').mode).toBe('expression');
    expect(prepareEvaluation('() => 1').mode).toBe('expression');
    expect(prepareEvaluation('const a = 1; return a;').mode).toBe('body');
  });

  it('reports syntax errors before touching the page', () => {
    expect(() => prepareEvaluation('function (')).toThrow(
      /Evaluation failed: SyntaxError: .*explicit return/
    );
  });
});

describe('evaluation wrapper', () => {
  it('awaits promises, calls functions and runs statement bodies', async () => {
    expect(await evaluateInVm('1 + 2')).toBe(3);
    expect(await evaluateInVm('Promise.resolve({ ok: [1, 2] })')).toEqual({ ok: [1, 2] });
    expect(await evaluateInVm('async () => "called"')).toBe('called');
    expect(await evaluateInVm('const a = 21; return a * 2;')).toBe(42);
    expect(await evaluateInVm('undefined')).toBeUndefined();
  });

  it('maps thrown errors to clear messages', async () => {
    await expect(evaluateInVm('null.x')).rejects.toThrow(/^Evaluation failed: TypeError: /);
    await expect(evaluateInVm('Promise.reject(new RangeError("nope"))')).rejects.toThrow(
      'Evaluation failed: RangeError: nope'
    );
  });

  it('caps large results and handles cycles and non-JSON values', async () => {
    const big = await evaluateInVm('"x".repeat(50000)', 1_000);
    expect(typeof big).toBe('string');
    expect(String(big)).toMatch(/… \[truncated: the result exceeded 1000 characters\]$/);
    expect(await evaluateInVm('(() => { const o = { a: 1 }; o.self = o; return o; })()')).toEqual({
      a: 1,
      self: '[Circular]',
    });
    expect(await evaluateInVm('[NaN, 10n, new Map([[1, 2]]), function named() {}]')).toEqual([
      'NaN',
      '10n',
      [[1, 2]],
      '[Function named]',
    ]);
  });
});

describe('serializeForAgent', () => {
  it('describes DOM-like nodes and stops at the character budget', () => {
    expect(serializeForAgent({ nodeType: 1, nodeName: 'BUTTON', id: 'go' }, 100).json).toBe(
      '"<button#go>"'
    );
    const result = serializeForAgent({ list: Array.from({ length: 1000 }, (_, i) => i) }, 50);
    expect(result.truncated).toBe(true);
    expect(result.json.length).toBe(50);
  });
});
