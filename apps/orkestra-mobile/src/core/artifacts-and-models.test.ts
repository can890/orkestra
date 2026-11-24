import { describe, expect, it } from 'vitest';
import { artifactKind, extractArtifactsFromText } from './artifacts';
import { groupMobileModelOptions } from './model-groups';

describe('extractArtifactsFromText & artifactKind', () => {
  it('markdown görseli, yerel dosya yolunu ve videoyu çıkarır', () => {
    const items = extractArtifactsFromText(
      'Kedi görseli hazır: ![Kedi](/Users/selim/out/kedi.png)\nVideo: `clip/demo.mp4`\nRapor: [Özet](file:///tmp/rapor.pdf)'
    );
    expect(items.map((i) => [i.name, artifactKind(i)])).toEqual([
      ['Kedi', 'image'],
      ['Özet', 'pdf'],
      ['demo.mp4', 'video'],
    ]);
  });

  it('sıradan web linklerini dosya kartına çevirmez', () => {
    const items = extractArtifactsFromText('Bak: [Google](https://google.com/docs/readme.md)');
    expect(items).toEqual([]);
  });
});

describe('groupMobileModelOptions', () => {
  it('gömülü efor varyantlarını Mac uygulamasındaki gibi tek model kartında gruplar', () => {
    const groups = groupMobileModelOptions(
      [
        { id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)', description: null },
        { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)', description: null },
        { id: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)', description: null },
        { id: 'claude-opus', name: 'Claude Opus', description: 'Derin akıl yürütme' },
      ],
      'gemini-4-neon-high',
      [],
      null
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: 'embedded-group',
      baseName: 'Gemini 4 Neon',
      isSelected: true,
    });
    if (groups[0]?.kind === 'embedded-group') {
      expect(groups[0].variants.map((v) => v.label)).toEqual(['Düşük', 'Orta', 'Yüksek']);
      expect(groups[0].activeVariant?.value).toBe('gemini-4-neon-high');
    }
    expect(groups[1]).toMatchObject({ kind: 'model', id: 'claude-opus', isSelected: false });
  });
});
