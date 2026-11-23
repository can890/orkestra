import { describe, expect, it } from 'vitest';
import { parseNotebookJson } from './notebook-renderer';

describe('parseNotebookJson', () => {
  it('parses kernel metadata and code/markdown cells', () => {
    const raw = JSON.stringify({
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python' },
      },
      cells: [
        { cell_type: 'markdown', source: ['# Başlık\n', 'Açıklama'] },
        {
          cell_type: 'code',
          execution_count: 1,
          source: 'print("merhaba")',
          outputs: [{ output_type: 'stream', text: ['merhaba\n'] }],
        },
      ],
    });

    const parsed = parseNotebookJson(raw);
    expect(parsed.kind).toBe('ready');
    if (parsed.kind === 'ready') {
      expect(parsed.kernelName).toBe('Python 3');
      expect(parsed.cells).toHaveLength(2);
    }
  });

  it('returns clear error on malformed json', () => {
    const parsed = parseNotebookJson('{bozuk');
    expect(parsed.kind).toBe('error');
  });
});
