import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildEnrichedPath,
  createSilentWavBytes,
  pickRecommendedModel,
  resolveLocalSnapshotPath,
  scanCachedWhisperModels,
} from './local-stt-runner';

describe('local-stt-runner helpers', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('builds deduplicated PATH including ~/.local/bin and /opt/homebrew/bin', () => {
    const pathValue = buildEnrichedPath('/Users/test/.venvs/w/bin');
    const parts = pathValue.split(':');
    expect(parts[0]).toBe('/Users/test/.venvs/w/bin');
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts.some((p) => p.endsWith('/.local/bin'))).toBe(true);
    expect(new Set(parts).size).toBe(parts.length);
  });

  it('scans cached HuggingFace whisper snapshots and resolves local directory', async () => {
    const hub = await mkdtemp(join(tmpdir(), 'ork-hf-test-'));
    tempDirs.push(hub);

    const mlxSnap = join(
      hub,
      'models--mlx-community--whisper-large-v3-turbo',
      'snapshots',
      'abc123'
    );
    await mkdir(mlxSnap, { recursive: true });
    await writeFile(join(mlxSnap, 'config.json'), '{}');

    const incomplete = join(hub, 'models--Systran--faster-whisper-small', 'snapshots', 'def');
    await mkdir(incomplete, { recursive: true });

    const models = await scanCachedWhisperModels(hub);
    expect(models).toEqual(['mlx-community/whisper-large-v3-turbo']);
    expect(await resolveLocalSnapshotPath('mlx-community/whisper-large-v3-turbo', hub)).toBe(
      mlxSnap
    );
    expect(await resolveLocalSnapshotPath('Systran/faster-whisper-small', hub)).toBeNull();
    expect(pickRecommendedModel('mlx-whisper', models)).toBe(
      'mlx-community/whisper-large-v3-turbo'
    );
  });

  it('generates valid RIFF/PCM silent WAV header', () => {
    const wav = createSilentWavBytes(400, 16_000);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(wav.byteLength).toBe(44 + 6400 * 2);
  });
});
