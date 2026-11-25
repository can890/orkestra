/**
 * Satır yüksekliği değişmezi: her satır türü için motorun ayırdığı yükseklik (virtualizer'daki
 * boyut, yani bir sonraki satırın konumuna olan uzaklık) ekranda çizilen yüksekliğe eşit olmalı.
 * Eşit değilse satır görüş alanına girdiğinde gerçek yüksekliği tahminin yerini alır, üstteki ve
 * alttaki konumlar kayar ve kaydırma "geri sıçrar".
 *
 * Gerçek bir ChatView üç genişlikte (geniş, bölünmüş bölme ~520 px, dar ~320 px) uzun ve karışık
 * bir dökümle kurulur, döküm baştan sona taranır ve görünür her satır için iki şey denetlenir:
 *   - ayrılan yükseklik == satır sarmalayıcısının offsetHeight'ı (±1 px)
 *   - içerik ayrılan kutudan taşmıyor (scrollHeight ≤ offsetHeight + 1)
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import {
  mixedTranscript,
  mountTranscript,
  paint,
  sleep,
  type Mounted,
} from './tests/scroll-fixture';

let mounted: Mounted | undefined;
// Medya kartları görüş alanına yakınlığa göre yüklenir: test çerçevesi en geniş dökümden büyük olsun.
beforeAll(() => page.viewport(1100, 900));
afterEach(() => {
  mounted?.dispose();
  mounted = undefined;
});

type Mismatch = { kind: string; id: string; reserved: number; rendered: number; what: string };

/** Görünür, art arda gelen satırlar için ayrılan ve çizilen yükseklikleri karşılaştırır. */
function collect(host: HTMLElement, seen: Map<string, number>, out: Map<string, Mismatch>) {
  const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-unit-id]'))
    .map((el) => ({
      el,
      index: Number(el.dataset.index),
      id: el.dataset.unitId!,
      kind: el.dataset.unitKind!,
      top: new DOMMatrixReadOnly(getComputedStyle(el).transform).m42,
    }))
    .sort((a, b) => a.index - b.index);
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const row = rows[i]!;
    const next = rows[i + 1]!;
    if (next.index !== row.index + 1) continue;
    const reserved = next.top - row.top;
    const rendered = row.el.offsetHeight;
    const overflow = row.el.scrollHeight;
    seen.set(row.kind, (seen.get(row.kind) ?? 0) + 1);
    if (Math.abs(reserved - rendered) > 1) {
      out.set(row.id, { kind: row.kind, id: row.id, reserved, rendered, what: 'height' });
    } else if (overflow > rendered + 1) {
      out.set(row.id, {
        kind: row.kind,
        id: row.id,
        reserved,
        rendered: overflow,
        what: 'overflow',
      });
    }
  }
}

describe('measured row height equals rendered height', () => {
  for (const width of [900, 520, 320]) {
    it(`for every row kind at ${width} px`, async () => {
      mounted = mountTranscript({ width, height: 800, turns: mixedTranscript(40) });
      const { host, scrollEl } = mounted;
      // Görseller ve widget'lar eşzamansız boyut alır; ilk taramadan önce yerleşsinler.
      await sleep(200);
      const seen = new Map<string, number>();
      const mismatches = new Map<string, Mismatch>();
      for (let pass = 0; pass < 2; pass += 1) {
        scrollEl.scrollTop = 0;
        await paint();
        for (let guard = 0; guard < 400; guard += 1) {
          await paint();
          await sleep(20);
          await paint();
          if (pass === 1) collect(host, seen, mismatches);
          const max = scrollEl.scrollHeight - scrollEl.clientHeight;
          if (scrollEl.scrollTop >= max - 1) break;
          scrollEl.scrollTop = Math.min(max, scrollEl.scrollTop + scrollEl.clientHeight / 2);
        }
      }
      const report = [...mismatches.values()].map(
        (m) => `${m.kind} ${m.id}: ${m.what} reserved=${m.reserved} rendered=${m.rendered}`
      );
      const kinds = [...seen.keys()].sort();
      expect(kinds).toEqual(
        expect.arrayContaining([
          'artifact',
          'diff',
          'execute',
          'file-op',
          'handoff-divider',
          'message',
          'plan',
          'resource-link',
          'subagent',
          'thinking',
          'thinking-group',
          'tool',
          'tool-group',
          'turn-outcome',
          'widget',
        ])
      );
      expect(report, `checked kinds: ${kinds.join(', ')}`).toEqual([]);
    }, 120_000);
  }
});
