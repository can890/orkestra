import type { PortableRelativePath } from '@orkestra/core/primitives/path/api';
import { describe, expect, it } from 'vitest';
import {
  describeCheckpointError,
  describeRestoreSummary,
  findPromptCheckpoint,
  groupPreviewFiles,
  previewIsEmpty,
} from './rewind-checkpoint-model';

const portable = (value: string) => value as PortableRelativePath;
const checkpoint = (seq: number, kind: 'prompt' | 'safety', promptId?: string) => ({
  seq,
  hash: `hash-${seq}`,
  createdAt: seq,
  kind,
  ...(promptId ? { promptId } : {}),
});

describe('findPromptCheckpoint', () => {
  it('matches the prompt checkpoint and ignores safety checkpoints', () => {
    const checkpoints = [checkpoint(1, 'prompt', 'a'), checkpoint(2, 'safety', 'a')];
    expect(findPromptCheckpoint(checkpoints, 'a')?.seq).toBe(1);
    expect(findPromptCheckpoint(checkpoints, 'missing')).toBeNull();
    expect(findPromptCheckpoint([], 'a')).toBeNull();
  });
});

describe('groupPreviewFiles', () => {
  const preview = {
    checkpoint: checkpoint(1, 'prompt', 'a'),
    files: [
      { path: portable('new.txt'), change: 'delete' as const },
      { path: portable('edited.txt'), change: 'overwrite' as const },
      { path: portable('edited-2.txt'), change: 'overwrite' as const },
    ],
    recreate: 0,
    overwrite: 2,
    delete: 1,
    truncated: false,
  };

  it('orders groups, keeps paths, and drops empty groups', () => {
    const groups = groupPreviewFiles(preview);
    expect(groups.map((group) => [group.change, group.total, group.paths])).toEqual([
      ['overwrite', 2, ['edited.txt', 'edited-2.txt']],
      ['delete', 1, ['new.txt']],
    ]);
  });

  it('keeps complete totals even when the file list was truncated', () => {
    const [group] = groupPreviewFiles({ ...preview, overwrite: 900, truncated: true });
    expect(group).toMatchObject({ change: 'overwrite', total: 900 });
    expect(group?.paths).toHaveLength(2);
  });

  it('detects a preview with nothing to restore', () => {
    expect(previewIsEmpty(preview)).toBe(false);
    expect(previewIsEmpty({ ...preview, files: [], recreate: 0, overwrite: 0, delete: 0 })).toBe(
      true
    );
  });
});

describe('describeCheckpointError', () => {
  it('prefers a message, falls back to the error type, then to a generic text', () => {
    expect(describeCheckpointError({ type: 'git_error', message: 'boom' })).toBe('boom');
    expect(describeCheckpointError({ type: 'project-missing' })).toContain('project-missing');
    expect(describeCheckpointError(new Error('thrown'))).toBe('thrown');
    expect(describeCheckpointError(undefined)).toBe('Bilinmeyen bir hata oluştu.');
  });
});

describe('describeRestoreSummary', () => {
  it('summarizes counts and the no-op case', () => {
    expect(describeRestoreSummary({ recreate: 1, overwrite: 2, delete: 3 })).toBe(
      '2 dosya eski haline döndü, 1 dosya yeniden oluşturuldu, 3 dosya silindi.'
    );
    expect(describeRestoreSummary({ recreate: 0, overwrite: 0, delete: 0 })).toBe(
      'Dosyalarda değişiklik gerekmedi.'
    );
  });
});
