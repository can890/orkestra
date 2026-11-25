/**
 * 2 000+ satırlık bir dökümde kaydırma ve akış maliyeti (bilgi amaçlı; `--project perf`).
 *
 * Ölçülenler:
 *   - tam tarama: scrollTop'u yarım ekran adımlarla baştan sona ilerletip her adımda bir kare
 *     beklemek; toplam süre, kare aralıklarının ortalaması/p95'i ve 50 ms'yi aşan kare sayısı,
 *   - tekerlek: gerçek tekerlek girdisiyle 60 adım yukarı (ölçülmemiş satırlar üstten girer),
 *   - akış: 2 000 satır geçmiş varken etkin turun 200 kez güncellenmesinin eşzamanlı maliyeti.
 */

import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { mixedTranscript, mountTranscript, sleep, wheel, type Item } from '../scroll-fixture';

const frame = () => new Promise<number>((resolve) => requestAnimationFrame((t) => resolve(t)));

function stats(intervals: number[]) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const mean = intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  return {
    frames: intervals.length,
    meanMs: Number(mean.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    over50: intervals.filter((d) => d > 50).length,
  };
}

/** rAF geri çağrılarının toplam çalışma süresi (motorun kare başına JS maliyeti). */
function timeAnimationFrames() {
  const original = window.requestAnimationFrame.bind(window);
  let busy = 0;
  let slowest = 0;
  window.requestAnimationFrame = (cb) =>
    original((t) => {
      const s = performance.now();
      try {
        cb(t);
      } finally {
        const d = performance.now() - s;
        busy += d;
        if (d > slowest) slowest = d;
      }
    });
  return {
    take: () => {
      const out = { busyMs: Number(busy.toFixed(1)), slowestMs: Number(slowest.toFixed(2)) };
      busy = 0;
      slowest = 0;
      return out;
    },
    restore: () => {
      window.requestAnimationFrame = original;
    },
  };
}

describe('scrolling a 2 000-row transcript', () => {
  it('reports sweep, wheel and streaming cost', async () => {
    await page.viewport(1100, 900);
    const raf = timeAnimationFrames();
    const m = mountTranscript({ width: 900, height: 800, turns: mixedTranscript(370) });
    try {
      await sleep(400);
      m.scrollEl.scrollTop = 0;
      await sleep(300);

      // Tam tarama
      const sweep: number[] = [];
      let last = await frame();
      raf.take();
      const t0 = performance.now();
      while (m.scrollEl.scrollTop < m.scrollEl.scrollHeight - m.scrollEl.clientHeight - 1) {
        m.scrollEl.scrollTop += 400;
        const t = await frame();
        sweep.push(t - last);
        last = t;
      }
      const sweepMs = performance.now() - t0;
      const sweepRaf = raf.take();
      const rows =
        Math.max(
          ...[...m.host.querySelectorAll<HTMLElement>('[data-index]')].map((el) =>
            Number(el.dataset.index)
          )
        ) + 1;

      // Tekerlek (aşağıdan yukarı, ölçülmemiş satırlar)
      await sleep(300);
      // Kare aralıkları arka planda örneklenir (tekerlek komutunun gidiş-dönüşü ölçüme girmez).
      const wheelFrames: number[] = [];
      let sampling = true;
      let prev = await frame();
      const sample = (t: number) => {
        wheelFrames.push(t - prev);
        prev = t;
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      raf.take();
      const t1 = performance.now();
      for (let k = 0; k < 60; k += 1) await wheel(m.scrollEl, -300);
      const wheelMs = performance.now() - t1;
      sampling = false;
      const wheelRaf = raf.take();

      // Akış
      let text = 'Akış. ';
      const ticks: number[] = [];
      for (let k = 0; k < 200; k += 1) {
        text += `parça ${k} `;
        const s = performance.now();
        m.state.transcript.activeTurn.set(
          {
            id: 'live',
            seq: 9999,
            initiator: 'user',
            items: [
              { kind: 'message', id: 'live-u', seq: 0, role: 'user', text: 'devam' },
              { kind: 'message', id: 'live-a', seq: 1, role: 'assistant', text },
            ] as Item[],
          },
          'generating'
        );
        ticks.push(performance.now() - s);
        if (k % 10 === 0) await frame();
      }

      const report = {
        rows,
        sweepMs: Math.round(sweepMs),
        sweep: stats(sweep),
        sweepRaf,
        wheelMs: Math.round(wheelMs),
        wheel: stats(wheelFrames),
        wheelRaf,
        streamTickMeanMs: Number((ticks.reduce((a, b) => a + b, 0) / ticks.length).toFixed(3)),
        streamTickMaxMs: Number(Math.max(...ticks).toFixed(3)),
      };
      console.log(`[perf] scroll-2000 ${JSON.stringify(report)}`);
      expect(rows).toBeGreaterThan(2000);
    } finally {
      m.dispose();
      raf.restore();
    }
  }, 300_000);
});
