import { describe, expect, it } from 'vitest';
import { splitDirectorySelectorPath } from './directory-selector';

describe('directory selector path parsing', () => {
  it('keeps a drive root attached to every Windows breadcrumb', () => {
    expect(splitDirectorySelectorPath(String.raw`D:\Projects\orkestra`, '\\')).toEqual([
      { label: 'D:', path: 'D:\\' },
      { label: 'Projects', path: String.raw`D:\Projects` },
      { label: 'orkestra', path: String.raw`D:\Projects\orkestra` },
    ]);
  });

  it('treats a UNC server and share as one filesystem root', () => {
    expect(splitDirectorySelectorPath(String.raw`\\server\share\Projects\orkestra`, '\\')).toEqual([
      { label: String.raw`\\server\share`, path: String.raw`\\server\share` },
      { label: 'Projects', path: String.raw`\\server\share\Projects` },
      { label: 'orkestra', path: String.raw`\\server\share\Projects\orkestra` },
    ]);
  });
});
