import { describe, expect, it } from 'vitest';
import {
  artifactDisplayName,
  artifactKind,
  extractArtifactsFromText,
  uniqueArtifacts,
} from './artifacts';
import { mapTurn } from './mappers';
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

  it('`file:` adresli bağlantıda ham adres yerine dosya adını gösterir ve aynı dosyayı bir kez listeler', () => {
    const items = extractArtifactsFromText(
      '- [demo_reel.mp4](/home/u/out/demo_reel.mp4) ' +
        '([file:// bağlantısı](file:///home/u/out/demo_reel.mp4))\n' +
        '- [file:// bağlantısı](file:///home/u/out/demo%20reel_720p.mp4)\n' +
        '- [NOTES.md](file:///home/u/chapters/NOTES.md)'
    );
    expect(items).toEqual([
      { uri: '/home/u/out/demo_reel.mp4', name: 'demo_reel.mp4' },
      { uri: 'file:///home/u/out/demo%20reel_720p.mp4', name: 'demo reel_720p.mp4' },
      { uri: 'file:///home/u/chapters/NOTES.md', name: 'NOTES.md' },
    ]);
  });

  it('dosya adı türetirken etiketleri ve adresleri ayırır', () => {
    expect(artifactDisplayName('file:///a/b.mp4', 'file:///a/b.mp4')).toBe('b.mp4');
    expect(artifactDisplayName('file:/a/b.mp4')).toBe('b.mp4');
    expect(artifactDisplayName('file://localhost/a/b.mp4', '  ')).toBe('b.mp4');
    expect(artifactDisplayName('/a/kapak.jpg', 'Tanıtım 9:16 Kapak Görseli')).toBe(
      'Tanıtım 9:16 Kapak Görseli'
    );
  });

  it('masaüstünden gelen çıktılar ile metindeki aynı dosyayı tek kartta birleştirir', () => {
    const [entry] = mapTurn({
      id: 't1',
      items: [
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: 'ok',
          artifacts: [{ uri: 'file:///home/u/out/v.mp4', name: 'file:///home/u/out/v.mp4' }],
        },
      ],
    });
    const artifacts = entry && 'artifacts' in entry ? (entry.artifacts ?? []) : [];
    expect(artifacts).toEqual([{ uri: 'file:///home/u/out/v.mp4', name: 'v.mp4' }]);
    expect(
      uniqueArtifacts([...artifacts, ...extractArtifactsFromText('`/home/u/out/v.mp4`')])
    ).toHaveLength(1);
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
