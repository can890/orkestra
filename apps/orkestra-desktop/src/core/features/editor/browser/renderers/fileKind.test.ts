import { describe, expect, it } from 'vitest';
import {
  getFileKind,
  isBinaryForDiff,
  isMonacoBackedKind,
  isPreviewableKind,
} from '@core/features/editor/api/browser/renderers/fileKind';

describe('fileKind', () => {
  it('treats csv, mermaid, and notebook as Monaco-backed preview kinds', () => {
    for (const file of ['customers.csv', 'arch.mmd', 'flow.mermaid', 'analysis.ipynb']) {
      const kind = getFileKind(file);
      expect(isPreviewableKind(kind)).toBe(true);
      expect(isMonacoBackedKind(kind)).toBe(true);
    }
  });

  it('routes pdf, fonts, and office files to dedicated read-only preview kinds', () => {
    expect(getFileKind('report.pdf')).toBe('pdf');
    expect(getFileKind('font.woff2')).toBe('font');
    expect(getFileKind('font.ttf')).toBe('font');
    expect(getFileKind('spec.docx')).toBe('office');
    expect(getFileKind('data.xlsx')).toBe('office');
    expect(getFileKind('deck.pptx')).toBe('office');

    for (const file of ['report.pdf', 'font.woff2', 'spec.docx', 'data.xlsx', 'deck.pptx']) {
      expect(isMonacoBackedKind(getFileKind(file))).toBe(false);
      expect(isBinaryForDiff(file)).toBe(true);
    }
  });
});
