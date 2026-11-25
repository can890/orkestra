/**
 * Kaydırma kararlılığı (gerçek Chromium, gerçek tekerlek girdisi).
 *
 * Kullanıcının şikâyeti: "sohbeti yukarı aşağı kaydırırken bazen yukarı veya aşağı gitmiyor, eski
 * yerine geri dönüyor". Bu testler uzun, karışık bir dökümde tekerlekle küçük ve büyük adımlarla
 * yukarı/aşağı kaydırır ve her girdiden sonra kare kare şunları denetler:
 *   - işaretçinin altındaki içerik tam olarak kaydırılan miktar kadar hareket eder (görsel sıçrama
 *     yok) ve yön tekerleğin yönüdür,
 *   - görünüm kendi kendine eski bir konuma dönmez (girdi yokken hareket yok),
 *   - bir tur akarken yukarı kaydırmak asla aşağı çekilmez, en alta inmek takibi yeniden başlatır.
 */

import { setVideoAspect } from '@components/rows/artifact/streamed-media';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import {
  fixtureCommands,
  mixedTranscript,
  mountTranscript,
  paint,
  rowAt,
  sleep,
  waitStill,
  wheel,
  type Item,
  type Mounted,
} from './tests/scroll-fixture';

let mounted: Mounted | undefined;
// Tekerlek girdisi işaretçinin altındaki öğeye gider: test çerçevesi en geniş dökümden büyük olmalı.
beforeAll(() => page.viewport(1100, 900));
afterEach(() => {
  mounted?.dispose();
  mounted = undefined;
});

// İzlenen içerik: görüş alanının en üstündeki satır. Görüş alanı içinde sonradan boyut alan bir
// satır (yüklenen bir widget) altındaki satırları meşru olarak iter; üstteki satır ise yalnızca
// kaydırmayla hareket etmeli.
const POINTER_Y = 2;

const topOf = (m: Mounted, id: string) =>
  m.host.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(id)}"]`)?.getBoundingClientRect()
    .top;

const maxScroll = (m: Mounted) => m.scrollEl.scrollHeight - m.scrollEl.clientHeight;

/**
 * Tekerleği çevirir, ardından ~20 kare + yerleşme süresi boyunca işaretçinin altındaki satırın
 * ekrandaki konumunu izler. Sorunları metin olarak döndürür.
 */
async function wheelAndWatch(
  m: Mounted,
  delta: number,
  label: string,
  opts: { exact?: boolean } = {}
): Promise<string[]> {
  const before = rowAt(m.host, m.scrollEl, POINTER_Y);
  if (!before) return [];
  const atTop = m.scrollEl.scrollTop <= 0;
  const atEnd = m.scrollEl.scrollTop >= maxScroll(m) - 1;
  await wheel(m.scrollEl, delta);
  const samples: number[] = [];
  for (let frame = 0; frame < 20; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const top = topOf(m, before.id);
    if (top !== undefined) samples.push(top);
  }
  await sleep(250);
  await paint();
  const settled = topOf(m, before.id);
  if (settled !== undefined) samples.push(settled);

  const problems: string[] = [];
  if (samples.length === 0) return problems;
  const moved = samples[0]! - before.top;
  // Tekerlek aşağı (delta > 0) içeriği yukarı (moved < 0) taşır.
  const clamped = atTop || m.scrollEl.scrollTop <= 0 || m.scrollEl.scrollTop >= maxScroll(m) - 1;
  if (opts.exact !== false && !clamped && Math.abs(moved + delta) > 1) {
    problems.push(`${label}: the top row moved ${moved.toFixed(1)} for wheel ${delta}`);
  }
  const exact = opts.exact !== false;
  const blocked = (delta < 0 && atTop) || (delta > 0 && atEnd);
  if (exact && !blocked && Math.abs(moved) < 1) {
    problems.push(`${label}: the wheel did not move the transcript (wheel ${delta})`);
  }
  if (exact && clamped && moved * delta > 1) {
    problems.push(`${label}: content moved ${moved.toFixed(1)} against wheel ${delta}`);
  }
  for (let i = 1; i < samples.length; i += 1) {
    if (Math.abs(samples[i]! - samples[0]!) > 1) {
      problems.push(
        `${label}: content moved by itself ${(samples[i]! - samples[0]!).toFixed(1)} px after the wheel (sample ${i})`
      );
      break;
    }
  }
  return problems;
}

async function mountAtBottom(width: number, turns = 60): Promise<Mounted> {
  const m = mountTranscript({ width, height: 700, turns: mixedTranscript(turns) });
  mounted = m;
  await sleep(250);
  m.view.scrollToBottom();
  await waitStill(m.scrollEl);
  await sleep(200);
  await paint();
  return m;
}

describe('wheel scrolling an idle transcript', () => {
  for (const width of [900, 520, 320]) {
    it(`moves the content by exactly the wheel delta and never snaps back (${width} px)`, async () => {
      const m = await mountAtBottom(width);
      const problems: string[] = [];
      // Yukarı: küçük ve büyük adımlar, araya duraklamalar; sonra aşağı geri.
      for (let k = 0; k < 45; k += 1) {
        const step = k % 3 === 0 ? -400 : k % 3 === 1 ? -100 : -40;
        problems.push(...(await wheelAndWatch(m, step, `up #${k}`)));
      }
      for (let k = 0; k < 25; k += 1) {
        const step = k % 2 === 0 ? 400 : 120;
        problems.push(...(await wheelAndWatch(m, step, `down #${k}`)));
      }
      expect(problems).toEqual([]);
    }, 240_000);
  }
});

describe('anchoring inside an item that spans several rows', () => {
  it('keeps a viewport that starts inside an output card in place when heights change', async () => {
    const m = await mountAtBottom(900, 40);
    // Bir yanıtın çıktı kartı (aynı öğenin ikinci satırı) görüş alanının üstüne gelsin.
    const card = [...m.host.querySelectorAll<HTMLElement>('[data-unit-kind="artifact"]')].at(-1);
    expect(card).toBeDefined();
    const cardId = card!.dataset.unitId!;
    // Görüş alanı kartın içinden başlasın (kullanıcının kaydırdığı gibi).
    const shift = card!.getBoundingClientRect().top - m.scrollEl.getBoundingClientRect().top + 20;
    m.scrollEl.scrollTop += shift;
    await waitStill(m.scrollEl);
    await sleep(250);
    await paint();
    const before = topOf(m, cardId)!;

    // Aşağıda bir yükseklik değişikliği: akan bir turun yanıtı büyür, bir video boyutunu öğrenir.
    const turn = (text: string) =>
      m.state.transcript.activeTurn.set(
        {
          id: 'live',
          seq: 999,
          initiator: 'user',
          items: [
            { kind: 'message', id: 'live-u', seq: 0, role: 'user', text: 'devam' },
            { kind: 'message', id: 'live-a', seq: 1, role: 'assistant', text },
          ] as Item[],
        },
        'generating'
      );
    turn('Başlıyorum.');
    await sleep(200);
    turn('Başlıyorum. '.repeat(40));
    setVideoAspect('/work/out/t34-clip.mp4', 1080, 1920);
    await sleep(300);
    await paint();
    expect(topOf(m, cardId)! - before).toBeCloseTo(0, 0);
  }, 60_000);
});

describe('wheel scrolling while a turn streams', () => {
  for (const width of [900, 320]) {
    it(`is never pulled back down, and re-engages following at the bottom (${width} px)`, async () => {
      const m = mountTranscript({
        width,
        height: 700,
        turns: mixedTranscript(30),
        commands: fixtureCommands(),
      });
      mounted = m;
      await sleep(250);

      let text = 'Akış başlıyor. ';
      let tools: Item[] = [];
      const publish = () =>
        m.state.transcript.activeTurn.set(
          {
            id: 'live',
            seq: 999,
            initiator: 'user',
            items: [
              { kind: 'message', id: 'live-u', seq: 0, role: 'user', text: 'Uzun bir iş yap' },
              ...tools,
              { kind: 'message', id: 'live-a', seq: 9, role: 'assistant', text },
            ] as Item[],
          },
          'generating'
        );
      publish();
      // Gönderimden sonra görünüm en altta kalır ve akışı izler (tail).
      m.view.setScrollMode({ kind: 'tail' });
      await waitStill(m.scrollEl);

      let tick = 0;
      const stream = () => {
        tick += 1;
        text += `Satır ${tick}: ajan yazmaya devam ediyor ve yanıt uzuyor. `;
        if (tick % 4 === 0) text += '\n\n';
        if (tick === 6) {
          tools = [
            {
              kind: 'execute-tool-call',
              id: 'live-e',
              seq: 1,
              toolCallId: 'live-e',
              title: 'ls out',
              command: 'ls out',
              status: 'done',
              outputText: '/work/out/live-shot.png',
            } as Item,
          ];
        }
        if (tick === 12) text += '\n\nGörsel: /work/out/live-reply.png\n\n';
        publish();
      };
      const timer = setInterval(stream, 40);
      try {
        await sleep(400);
        expect(maxScroll(m) - m.scrollEl.scrollTop).toBeLessThanOrEqual(1);

        // Eşik (48 px) içinde kalan küçük adımlar ve büyük adımlarla yukarı.
        const problems: string[] = [];
        for (let k = 0; k < 12; k += 1) {
          const step = k < 3 ? -30 : k % 2 === 0 ? -250 : -90;
          // İlk girdi gelene kadar görünüm akışı izlemeye devam eder (meşru); bu adımda yalnızca
          // yön ve kendiliğinden hareket denetlenir.
          problems.push(
            ...(await wheelAndWatch(m, step, `up while streaming #${k}`, { exact: k > 0 }))
          );
        }
        expect(problems).toEqual([]);
        // Duraklama: akış sürer, görünüm aşağı çekilmez.
        const parked = rowAt(m.host, m.scrollEl, POINTER_Y)!;
        await sleep(600);
        expect(topOf(m, parked.id)! - parked.top).toBeCloseTo(0, 0);

        // En alta in: takip yeniden başlar ve yeni içerikle birlikte en altta kalır.
        for (let k = 0; k < 40 && maxScroll(m) - m.scrollEl.scrollTop > 1; k += 1) {
          await wheel(m.scrollEl, 400);
          await paint();
        }
        await sleep(400);
        await paint();
        expect(maxScroll(m) - m.scrollEl.scrollTop).toBeLessThanOrEqual(1);
      } finally {
        clearInterval(timer);
      }
      // Tur biter: görünüm en altta kalır.
      m.state.transcript.activeTurn.commit('done');
      await sleep(300);
      await paint();
      expect(maxScroll(m) - m.scrollEl.scrollTop).toBeLessThanOrEqual(1);
    }, 120_000);
  }
});

describe('a small move up with the scrollbar while a turn streams', () => {
  it('stops following even inside the stick threshold', async () => {
    const m = mountTranscript({ width: 900, height: 700, turns: mixedTranscript(20) });
    mounted = m;
    await sleep(250);
    let text = 'Akış. ';
    const publish = () =>
      m.state.transcript.activeTurn.set(
        {
          id: 'live',
          seq: 999,
          initiator: 'user',
          items: [
            { kind: 'message', id: 'live-u', seq: 0, role: 'user', text: 'devam' },
            { kind: 'message', id: 'live-a', seq: 1, role: 'assistant', text },
          ] as Item[],
        },
        'generating'
      );
    publish();
    m.view.setScrollMode({ kind: 'tail' });
    await waitStill(m.scrollEl);
    const timer = setInterval(() => {
      text += 'Ajan yazmaya devam ediyor ve yanıt uzuyor. ';
      publish();
    }, 40);
    try {
      await sleep(300);
      // Kaydırma çubuğuyla 20 px yukarı (tekerlek olayı yok, yalnızca scroll olayı).
      m.scrollEl.scrollTop -= 20;
      await paint();
      const parked = rowAt(m.host, m.scrollEl, POINTER_Y)!;
      await sleep(500);
      await paint();
      expect(topOf(m, parked.id)! - parked.top).toBeCloseTo(0, 0);
      expect(maxScroll(m) - m.scrollEl.scrollTop).toBeGreaterThan(40);
    } finally {
      clearInterval(timer);
    }
  }, 60_000);
});

describe('a smooth scroll the user interrupts', () => {
  it('lets the user keep the position: a later height change does not pull the view to the end', async () => {
    const m = await mountAtBottom(900, 40);
    m.scrollEl.scrollTop = Math.round(maxScroll(m) / 2);
    await waitStill(m.scrollEl);
    await sleep(250);

    m.view.scrollToBottom({ behavior: 'smooth' });
    await paint();
    // Kullanıcı tekerlekle araya girer (tarayıcı yumuşak kaydırmayı iptal eder).
    await wheel(m.scrollEl, -300);
    await waitStill(m.scrollEl);
    await sleep(300);
    const parked = rowAt(m.host, m.scrollEl, POINTER_Y)!;

    // Sonradan bir yükseklik değişikliği (akan tur) olur.
    m.state.transcript.activeTurn.set(
      {
        id: 'live',
        seq: 999,
        initiator: 'user',
        items: [
          { kind: 'message', id: 'live-u', seq: 0, role: 'user', text: 'devam' },
          { kind: 'message', id: 'live-a', seq: 1, role: 'assistant', text: 'yazıyor '.repeat(80) },
        ] as Item[],
      },
      'generating'
    );
    await sleep(400);
    await paint();
    expect(maxScroll(m) - m.scrollEl.scrollTop).toBeGreaterThan(100);
    expect(topOf(m, parked.id)! - parked.top).toBeCloseTo(0, 0);
  }, 60_000);
});
