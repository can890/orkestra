import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from './chat-context';
import { createChatView } from './chat-view';
import type { ChatCommands, TranscriptTurn } from './index';
import { NOTIFY_DELAY_MS } from './state/artifact-availability';
import { createChatState } from './state/chat-state';

// Ajan yazarken (etkin tur akarken) dökümdeki medya kartları kaybolup geri gelmemeli: her akış
// güncellemesinde aynı DOM düğümü yerinde kalır, medya yeniden istenmez ve satır kutuları üst üste
// binmez.

type Item = TranscriptTurn['items'][number];

const cleanups: Array<() => void> = [];
const errors = vi.spyOn(console, 'error');
const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, NOTIFY_DELAY_MS + 10));
  await paint();
  await paint();
};
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  expect(errors).not.toHaveBeenCalled();
  errors.mockClear();
});

function mount(commands: ChatCommands) {
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed([]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:1400px';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host, commands });
  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  return { host, state };
}

const exec = (id: string, seq: number, command: string, outputText: string): Item => ({
  kind: 'execute-tool-call',
  id,
  seq,
  toolCallId: id,
  title: command,
  command,
  status: 'done',
  outputText,
});

const subagent = (id: string, seq: number, outputText = ''): Item => ({
  kind: 'spawn-subagent-tool-call',
  id,
  seq,
  toolCallId: id,
  title: `Agent ${id}`,
  name: `Agent ${id}`,
  status: 'running',
  background: true,
  outputText,
});

/** Contiguous commands fold into one group whose id derives from the first command. */
const group = (children: Item[]): Item =>
  ({
    kind: 'tool-group',
    id: `${children[0]!.id}:group`,
    seq: children[0]!.seq,
    label: `Ran ${children.length} commands`,
    groupKind: 'tool-run',
    status: 'done',
    children,
  }) as unknown as Item;

const user: Item = { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'render' };
const lsOutput = [
  '/work/out/big-render.mp4',
  '/work/out/voiceover-final-mix-v2.mp3',
  '/work/out/teaser.mp4',
].join('\n');

/**
 * One streaming turn as the ACP runtime delivers it: commands whose output lists media paths,
 * a thinking step, background sub-agents that tick, assistant text deltas and a second command
 * run that mentions more media.
 */
function steps(): Item[][] {
  const e1 = exec('e1', 1, 'ls /work/out', lsOutput);
  const e2 = exec('e2', 2, 'cp a b', 'cp /work/out/teaser.mp4 /work/share/teaser.mp4');
  const thinking: Item = { kind: 'thinking', id: 'th', seq: 3, text: 'Checking outputs' } as Item;
  const s = (tick: number) => [
    subagent('a1', 4, `step ${tick}`),
    subagent('a2', 5, `step ${tick * 2}`),
    subagent('a3', 6, `step ${tick * 3}`),
  ];
  const e3 = exec('e3', 7, 'ls /work/shots', '/work/shots/shot-1.png\n/work/shots/shot-2.png');
  const reply = (text: string): Item => ({
    kind: 'message',
    id: 'reply',
    seq: 9,
    role: 'assistant',
    text,
  });
  const e4 = exec('e4', 10, 'echo done', 'done');
  return [
    [user, e1],
    [user, group([e1, e2])],
    [user, group([e1, e2]), thinking],
    [user, group([e1, e2]), thinking, ...s(1)],
    [user, group([e1, e2]), thinking, ...s(2)],
    [user, group([e1, e2]), thinking, ...s(2), e3],
    [user, group([e1, e2]), thinking, ...s(3), e3, subagent('a4', 8)],
    [user, group([e1, e2]), thinking, ...s(4), e3, subagent('a4', 8, 'x'), reply('Kontrol')],
    [
      user,
      group([e1, e2]),
      thinking,
      ...s(5),
      e3,
      subagent('a4', 8, 'xy'),
      reply('Kontrol ediyorum, çıktılar hazır.'),
    ],
    [
      user,
      group([e1, e2]),
      thinking,
      ...s(6),
      e3,
      subagent('a4', 8, 'xyz'),
      reply('Kontrol ediyorum, çıktılar hazır. Devam'),
      e4,
    ],
  ];
}

const card = (host: HTMLElement, name: string) =>
  host.querySelector<HTMLElement>(`section[aria-label="Output: ${name}"]`);

/** Visible row wrappers must not overlap: each starts at or below the previous one's bottom. */
function overlaps(host: HTMLElement): string[] {
  const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-index]'))
    .map((el) => ({ index: Number(el.dataset.index), rect: el.getBoundingClientRect() }))
    .sort((a, b) => a.index - b.index);
  const problems: string[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!;
    const next = rows[i]!;
    if (next.index !== prev.index + 1) continue;
    if (prev.rect.height > 0 && prev.rect.bottom > next.rect.top + 1) {
      problems.push(
        `row ${prev.index} bottom ${prev.rect.bottom.toFixed(1)} > row ${next.index} top ${next.rect.top.toFixed(1)}`
      );
    }
  }
  return problems;
}

describe('artifact cards while the turn streams', () => {
  it('keep the same card, the same media request and a stable box on every update', async () => {
    const minted: string[] = [];
    const aborted: string[] = [];
    const commands: ChatCommands = {
      artifactExists: async () => true,
      // Never settles: the card keeps its request open; a remount would abort it and mint again.
      mediaUrlForArtifact: (artifact, options) => {
        minted.push(artifact.uri);
        options?.signal?.addEventListener('abort', () => aborted.push(artifact.uri));
        return new Promise(() => undefined);
      },
      resolveArtifact: () => new Promise(() => undefined),
    };
    const { host, state } = mount(commands);
    const all = steps();
    const setTurn = (items: Item[]) =>
      state.transcript.activeTurn.set({ id: 't', seq: 0, initiator: 'user', items }, 'generating');

    setTurn(all[0]!);
    await settle();
    const video = card(host, 'big-render.mp4');
    const audio = card(host, 'voiceover-final-mix-v2.mp3');
    expect(video).not.toBeNull();
    expect(audio).not.toBeNull();

    // Every card removal is recorded, also between paints.
    const removed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const sections = [
            ...(node.matches('section[aria-label^="Output: "]') ? [node] : []),
            ...Array.from(node.querySelectorAll('section[aria-label^="Output: "]')),
          ];
          for (const section of sections) removed.push(section.getAttribute('aria-label')!);
        }
      }
    });
    observer.observe(host, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());

    let shots: Array<HTMLElement | null> | undefined;
    for (let i = 1; i < all.length; i += 1) {
      setTurn(all[i]!);
      await settle();
      const step = `step ${i}`;
      expect(card(host, 'big-render.mp4'), step).toBe(video);
      expect(card(host, 'voiceover-final-mix-v2.mp3'), step).toBe(audio);
      expect(video!.getBoundingClientRect().height, step).toBeGreaterThan(100);
      const current = [card(host, 'shot-1.png'), card(host, 'shot-2.png')];
      if (shots) expect(current, step).toEqual(shots);
      else if (current[0]) shots = current;
      expect(overlaps(host), step).toEqual([]);
    }
    expect(shots?.every(Boolean)).toBe(true);
    expect(removed).toEqual([]);
    expect(aborted).toEqual([]);
    // One request per streamed file for the whole turn.
    for (const uri of [
      '/work/out/big-render.mp4',
      '/work/out/teaser.mp4',
      '/work/out/voiceover-final-mix-v2.mp3',
    ]) {
      expect(minted.filter((entry) => entry === uri)).toHaveLength(1);
    }
  });

  it('keep later cards mounted and rows apart when an earlier card appears late', async () => {
    const waiting: Array<(exists: boolean) => void> = [];
    const commands: ChatCommands = {
      // The first command's files are confirmed only after the rest of the turn streamed in.
      artifactExists: (artifact) =>
        artifact.uri.startsWith('/work/out/')
          ? new Promise((resolve) => waiting.push(resolve))
          : Promise.resolve(artifact.uri.startsWith('/work/shots/')),
      mediaUrlForArtifact: () => new Promise(() => undefined),
      resolveArtifact: () => new Promise(() => undefined),
    };
    const { host, state } = mount(commands);
    state.transcript.activeTurn.set(
      { id: 't', seq: 0, initiator: 'user', items: steps()[8]! },
      'generating'
    );
    await settle();
    const shot = card(host, 'shot-1.png');
    expect(shot).not.toBeNull();
    expect(card(host, 'big-render.mp4')).toBeNull();

    for (const resolve of waiting) resolve(true);
    await settle();
    expect(card(host, 'big-render.mp4')).not.toBeNull();
    expect(card(host, 'shot-1.png')).toBe(shot);
    expect(overlaps(host)).toEqual([]);
  });

  it('keep rows apart when cards appear mid-list after scrolling', async () => {
    const waiting = new Map<string, (exists: boolean) => void>();
    const commands: ChatCommands = {
      artifactExists: (artifact) => new Promise((resolve) => waiting.set(artifact.uri, resolve)),
      mediaUrlForArtifact: () => new Promise(() => undefined),
      resolveArtifact: () => new Promise(() => undefined),
    };
    const { host, state } = mount(commands);
    host.style.height = '700px';
    const items: Item[] = [user];
    for (let i = 0; i < 30; i += 1) {
      const output = i % 3 === 0 ? `/w/${i}/a.mp4\n/w/${i}/v.mp3` : 'ok';
      items.push(exec(`c${i}`, i * 3 + 1, `make ${i}`, output));
      items.push(subagent(`s${i}`, i * 3 + 2, 'x'));
      items.push({
        kind: 'message',
        id: `m${i}`,
        seq: i * 3 + 3,
        role: 'assistant',
        text: `text ${i} `.repeat(30),
      });
    }
    state.transcript.activeTurn.set({ id: 't', seq: 0, initiator: 'user', items }, 'generating');
    await settle();
    const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
    const problems: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      scroller.scrollTop = (round * 997) % Math.max(1, scroller.scrollHeight - 700);
      scroller.dispatchEvent(new Event('scroll'));
      await settle();
      const pending = [...waiting.keys()];
      const pick = pending[(round * 7) % Math.max(1, pending.length)];
      if (pick) {
        const dir = pick.split('/').slice(0, 3).join('/');
        for (const uri of pending) {
          if (!uri.startsWith(`${dir}/`)) continue;
          waiting.get(uri)!(true);
          waiting.delete(uri);
        }
      }
      await settle();
      problems.push(...overlaps(host).map((problem) => `round ${round}: ${problem}`));
    }
    expect(problems).toEqual([]);
  });
});

describe('artifact cards when the turn ends', () => {
  it('keep every card mounted when the active turn moves into history', async () => {
    const minted: string[] = [];
    const resolved: string[] = [];
    const commands: ChatCommands = {
      artifactExists: async () => true,
      mediaUrlForArtifact: (artifact) => {
        minted.push(artifact.uri);
        return new Promise(() => undefined);
      },
      resolveArtifact: (artifact) => {
        resolved.push(artifact.uri);
        return new Promise(() => undefined);
      },
    };
    const { host, state } = mount(commands);
    const all = steps();
    const final: Item = {
      kind: 'message',
      id: 'reply',
      seq: 9,
      role: 'assistant',
      text: 'Video: /work/out/big-render.mp4 Tamam.',
    };
    const items = all[9]!.map((item) => (item.id === 'reply' ? final : item));
    const turn = (list: Item[]): TranscriptTurn => ({
      id: 't',
      seq: 0,
      initiator: 'user',
      items: list,
    });
    for (const step of all) {
      state.transcript.activeTurn.set(turn(step), 'generating');
      await settle();
    }
    // The final chunk names the video: its card moves to the reply while the turn still streams.
    state.transcript.activeTurn.set(turn(items), 'generating');
    await settle();
    const names = [
      'big-render.mp4',
      'voiceover-final-mix-v2.mp3',
      'teaser.mp4',
      'shot-1.png',
      'shot-2.png',
    ];
    const before = names.map((name) => card(host, name));
    expect(before.every(Boolean)).toBe(true);
    const requests = minted.length + resolved.length;

    // end_turn as the host delivers it: the live turn is cleared (kept as a retained turn) ...
    state.transcript.activeTurn.set(null);
    await settle();
    names.forEach((name, i) => expect(card(host, name), name).toBe(before[i]));
    // ... then the committed history page arrives with the same turn.
    state.transcript.history.replace([structuredClone(turn(items))]);
    await settle();
    names.forEach((name, i) => expect(card(host, name), name).toBe(before[i]));
    expect(minted.length + resolved.length).toBe(requests);
    expect(overlaps(host)).toEqual([]);
  });
});

describe('mixed galleries', () => {
  it('reserve exactly the rendered height while a gallery grows and changes kind', async () => {
    const commands: ChatCommands = {
      artifactExists: async () => true,
      mediaUrlForArtifact: () => new Promise(() => undefined),
      resolveArtifact: () => new Promise(() => undefined),
    };
    const { host, state } = mount(commands);
    const outputs = [
      ['/w/a.mp4'],
      ['/w/a.mp4', '/w/v.mp3'],
      ['/w/a.mp4', '/w/v.mp3', '/w/b.mp4'],
      ['/w/a.mp4', '/w/v.mp3', '/w/b.mp4', '/w/c.png'],
      ['/w/a.mp4', '/w/v.mp3', '/w/b.mp4', '/w/c.png', '/w/d.pdf', '/w/w.wav'],
      ['/w/c.png', '/w/e.png', '/w/v.mp3'],
      ['/w/c.png', '/w/e.png', '/w/v.mp3', '/w/a.mp4'],
    ];
    for (const [i, paths] of outputs.entries()) {
      state.transcript.activeTurn.set(
        {
          id: 't',
          seq: 0,
          initiator: 'user',
          items: [
            user,
            exec('c', 1, 'ls', paths.join('\n')),
            subagent('s', 2, 'x'),
            { kind: 'message', id: 'r', seq: 3, role: 'assistant', text: 'after' },
          ],
        },
        'generating'
      );
      await settle();
      const step = `step ${i}`;
      const row = card(host, paths[0]!.split('/').pop()!)!.closest<HTMLElement>('[data-index]')!;
      const next = host.querySelector<HTMLElement>(
        `[data-index="${Number(row.dataset.index) + 1}"]`
      )!;
      const reserved = next.getBoundingClientRect().top - row.getBoundingClientRect().top;
      expect(row.getBoundingClientRect().height, step).toBeCloseTo(reserved, 0);
      // One media item per tile: every card is its own box, none inside another.
      for (const section of host.querySelectorAll('section[aria-label^="Output: "]')) {
        expect(section.parentElement!.closest('section[aria-label^="Output: "]'), step).toBeNull();
      }
      expect(overlaps(host), step).toEqual([]);
    }
  });
});
