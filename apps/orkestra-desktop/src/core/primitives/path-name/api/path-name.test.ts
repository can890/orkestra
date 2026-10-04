import { describe, expect, it } from 'vitest';
import { basenameFromAnyPath, safePathSegment } from './path-name';

describe('path-name helpers', () => {
  describe('basenameFromAnyPath', () => {
    it('extracts a project name from a Windows path', () => {
      expect(basenameFromAnyPath('E:\\my_work\\github_pro\\orkestra')).toBe('orkestra');
    });

    it('extracts a project name from a POSIX path', () => {
      expect(basenameFromAnyPath('/home/admin/github_pro/orkestra')).toBe('orkestra');
    });

    it('ignores trailing path separators', () => {
      expect(basenameFromAnyPath('E:\\my_work\\github_pro\\orkestra\\')).toBe('orkestra');
      expect(basenameFromAnyPath('/home/admin/github_pro/orkestra/')).toBe('orkestra');
    });
  });

  describe('safePathSegment', () => {
    it('keeps normal project names unchanged', () => {
      expect(safePathSegment('orkestra')).toBe('orkestra');
    });

    it('collapses path-shaped project names to a safe single segment', () => {
      expect(safePathSegment('E:\\my_work\\github_pro\\orkestra')).toBe('orkestra');
      expect(safePathSegment('../orkestra')).toBe('orkestra');
    });

    it('falls back when no safe segment remains', () => {
      expect(safePathSegment('///', 'project-id')).toBe('project-id');
    });

    it('falls back for Windows reserved device names', () => {
      expect(safePathSegment('NUL', 'project-id')).toBe('project-id');
      expect(safePathSegment('com1', 'project-id')).toBe('project-id');
    });
  });
});
