import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ReviewMarks } from './review-marks';

it('shares persisted review marks by pull request and account and removes dismissed marks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-review-marks-'));
  try {
    const file = join(directory, 'marks.json');
    const marks = new ReviewMarks(file);
    const mark = { path: 'src/main.ts', revision: 'revision-one' };
    marks.set('pr-one', 'account-one', mark, true);

    const reopened = new ReviewMarks(file);
    expect(reopened.get('pr-one', 'account-one')).toEqual([mark]);
    expect(reopened.get('pr-one', 'account-two')).toEqual([]);
    expect(reopened.get('pr-two', 'account-one')).toEqual([]);

    reopened.removeUnviewed('pr-one', 'account-one', new Set([mark.path]));
    expect(new ReviewMarks(file).get('pr-one', 'account-one')).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
