import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from './chat-context';
import { createChatView } from './chat-view';
import type { ChatCommands, TranscriptTurn } from './index';
import { createChatState } from './state/chat-state';

// Effect errors escape as uncaught window errors, not console.error.
const uncaught: string[] = [];
window.addEventListener('error', (event) => uncaught.push(String(event.message)));
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const later = <T,>(settle: () => T) =>
  new Promise<T>((resolve, reject) =>
    setTimeout(
      () => {
        try {
          resolve(settle());
        } catch (error) {
          reject(error);
        }
      },
      30 + Math.random() * 400
    )
  );

/** A long transcript whose path references all become existence probes. */
function turns(count: number): TranscriptTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `turn-${i}`,
    seq: i,
    initiator: 'agent' as const,
    items: [
      {
        kind: 'message',
        id: `m-${i}`,
        seq: 0,
        role: 'assistant',
        text: `Logo \`/brand/mark-${i}.png\` ve /tmp/out-${i}.png dosyası.`,
      },
      {
        kind: 'unknown-tool-call',
        id: `t-${i}`,
        seq: 1,
        toolCallId: `t-${i}`,
        title: 'Make',
        status: 'done',
        artifacts: [{ uri: `/tmp/made-${i}.png`, name: `made-${i}.png` }],
      } as TranscriptTurn['items'][number],
    ],
  }));
}

function mount(commands: () => ChatCommands) {
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed(turns(2500));
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:900px';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host, commands: commands() });
  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  return view;
}

// Answers that land after rows are mounted insert and remove cards mid-list. Rows keyed by index
// used to keep driving the tween entry of the unit they mounted with, and two rows sharing one
// entry ping-ponged effects until the call stack overflowed.
describe('output cards appearing in a long mounted transcript', () => {
  it.each([
    ['slow, mixed answers', (uri: string) => later(() => uri.includes('/tmp/'))],
    [
      'slow failures',
      () =>
        later(() => {
          throw new Error('host unavailable');
        }),
    ],
    ['immediate answers', () => Promise.resolve(true)],
  ] as const)('%s never loop', async (_label, answer) => {
    uncaught.length = 0;
    const commands = (): ChatCommands => ({
      artifactExists: (artifact) => answer(artifact.uri),
      resolveArtifact: () => Promise.reject(new Error('not needed')),
    });
    const view = mount(commands);
    await wait(300);
    // Hosts rebuild their command objects on every render.
    for (let i = 0; i < 5; i++) {
      view.setCommands(commands());
      await wait(50);
    }
    await wait(2500);
    expect(uncaught).toEqual([]);
  });
});
