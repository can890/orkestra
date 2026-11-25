import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export type ReviewMark = { path: string; revision: string };

export class ReviewMarks {
  private entries: Map<string, ReviewMark[]>;
  version = 0;

  constructor(private readonly file?: string) {
    try {
      this.entries = file ? new Map(JSON.parse(readFileSync(file, 'utf8'))) : new Map();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      this.entries = new Map();
    }
  }

  get(pr: string, account: string): ReviewMark[] {
    return this.entries.get(JSON.stringify([pr, account])) ?? [];
  }

  removeUnviewed(pr: string, account: string, paths: ReadonlySet<string>): void {
    const current = this.get(pr, account);
    const next = current.filter((entry) => !paths.has(entry.path));
    if (next.length !== current.length) this.save(pr, account, next);
  }

  set(pr: string, account: string, mark: ReviewMark, viewed: boolean): void {
    const marks = this.get(pr, account).filter((entry) => entry.path !== mark.path);
    if (viewed) marks.push(mark);
    this.save(pr, account, marks);
  }

  private save(pr: string, account: string, marks: ReviewMark[]): void {
    const key = JSON.stringify([pr, account]);
    const entries = new Map(this.entries);
    if (marks.length) entries.set(key, marks);
    else entries.delete(key);
    if (this.file) {
      const next = this.file + '.tmp';
      writeFileSync(next, JSON.stringify([...entries]), { mode: 0o600 });
      renameSync(next, this.file);
    }
    this.entries = entries;
    this.version += 1;
  }
}
