/**
 * scroll-fixture — kaydırma kararlılığı testleri için uzun, gerçekçi ve karışık bir döküm ile
 * gerçek Chromium'da tekerlek (wheel) kaydırması sürmeye yarayan yardımcılar.
 *
 * Döküm, masaüstündeki tipik bir sohbete benzer: kısa/uzun/çok satırlı kullanıcı balonları,
 * kod bloklu ve listeli markdown yanıtları, düşünme satırları, Türkçe etiketli araç grupları,
 * tek komut satırları, dosya okuma/düzenleme satırları, alt ajanlar, plan, sistem bildirimi,
 * hata/iptal sonuçları ve eşzamansız yüklenen görsel/video/ses kartları.
 */

import { DEFAULT_THEME } from '@core/theme';
import { userEvent } from 'vitest/browser';
import { createChatContext } from '@/chat-context';
import { createChatView, type ChatView } from '@/chat-view';
import type { ChatCommands } from '@/commands';
import type { TranscriptTurn } from '@/model';
import { createChatState, type ChatState } from '@/state/chat-state';

export type Item = TranscriptTurn['items'][number];

const LOREM =
  'Bu değişiklik kaydırma motorunun satır yüksekliklerini nasıl tuttuğunu etkiliyor; ' +
  'ölçülen yükseklik ile ekranda çizilen yükseklik aynı olmazsa görünür içerik kayar. ';

const CODE = [
  '```ts',
  'export function clamp(value: number, min: number, max: number): number {',
  '  if (value < min) return min;',
  '  if (value > max) return max;',
  '  return value;',
  '}',
  '',
  'const longLine = "bu satır dar bölmede yatay kaydırma gerektirecek kadar uzun bir dizgedir ve kırılmaz";',
  '```',
].join('\n');

function exec(id: string, command: string, outputText: string): Item {
  return {
    kind: 'execute-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: command,
    command,
    status: 'done',
    outputText,
  } as Item;
}

function read(id: string, path: string): Item {
  return {
    kind: 'read-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: `Read ${path}`,
    status: 'done',
    path,
    locations: [{ path }],
  } as unknown as Item;
}

function modify(id: string, path: string): Item {
  return {
    kind: 'modify-file-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: `Edit ${path}`,
    status: 'done',
    path,
    oldText: 'const a = 1;\nconst b = 2;\nexport { a, b };\n',
    newText: 'const a = 1;\nconst b = 3;\nconst c = a + b;\nexport { a, b, c };\n',
    locations: [{ path }],
  } as unknown as Item;
}

function group(id: string, children: Item[], label: string): Item {
  return {
    kind: 'tool-group',
    id: `${id}:group`,
    seq: 0,
    label,
    groupKind: 'tool-run',
    status: 'done',
    children,
  } as unknown as Item;
}

function subagent(id: string, name: string): Item {
  return {
    kind: 'spawn-subagent-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: name,
    name,
    status: 'done',
    outputText: 'Alt ajan işini bitirdi ve özetini yazdı.',
  } as Item;
}

function unknownTool(id: string, name: string): Item {
  return {
    kind: 'unknown-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: `${name}: kaydırma sıçraması`,
    name,
    toolKind: 'fetch',
    status: 'done',
  } as Item;
}

function widget(id: string): Item {
  return {
    kind: 'unknown-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: 'mcp__orkestra-widgets__show_widget',
    name: 'mcp__orkestra-widgets__show_widget',
    toolKind: 'other',
    status: 'done',
    widget: {
      title: 'Küçük grafik',
      html: '<div style="height:120px;background:#eee">grafik</div>',
    },
  } as unknown as Item;
}

function resourceLink(id: string): Item {
  return {
    kind: 'resource-link',
    id,
    uri: 'file:///packages/chat-ui/src/model.ts',
    name: 'model.ts',
    title: 'model.ts',
    mimeType: 'text/typescript',
    target: { kind: 'workspace-file', path: 'packages/chat-ui/src/model.ts' },
    status: 'done',
  } as unknown as Item;
}

function handoff(id: string): Item {
  return {
    kind: 'handoff-divider',
    id,
    fromProviderId: 'claude',
    fromLabel: 'Claude Code',
    toProviderId: 'codex',
    toLabel: 'Codex',
  } as unknown as Item;
}

function thinking(id: string, text: string): Item {
  return {
    kind: 'thinking',
    id,
    seq: 0,
    status: 'done',
    text,
    startedAt: 0,
    durationMs: 4200,
  } as unknown as Item;
}

function user(id: string, text: string): Item {
  return { kind: 'message', id, seq: 0, role: 'user', text, createdAt: Date.now() - 3_600_000 };
}

function assistant(id: string, text: string): Item {
  return { kind: 'message', id, seq: 0, role: 'assistant', text };
}

/** Ev sahibinin kendi gönderdiği (sistem) mesajların metni bu önekle başlar. */
export const SYSTEM_NOTICE_PREFIX = '[devir]';

/** Bir turun gövdesi; `i` turun sırası, içerik türleri tura göre döner. */
function turnItems(i: number): Item[] {
  const p = `t${i}`;
  const kind = i % 8;
  const items: Item[] = [];
  if (kind === 0) {
    items.push(user(`${p}-u`, 'Kısa bir soru?'));
  } else if (kind === 3) {
    items.push(
      user(
        `${p}-u`,
        Array.from({ length: 6 }, (_, k) => `${k + 1}. satır: ${LOREM.slice(0, 60 + k * 9)}`).join(
          '\n'
        )
      )
    );
  } else if (kind === 6) {
    items.push(user(`${p}-u`, `${SYSTEM_NOTICE_PREFIX} ${LOREM.repeat(3)}`));
  } else {
    items.push(user(`${p}-u`, LOREM.repeat(1 + (i % 3))));
  }

  if (i % 2 === 0) items.push(thinking(`${p}-th`, LOREM.repeat(2)));
  if (i % 4 === 1) {
    items.push(thinking(`${p}-th1`, LOREM), thinking(`${p}-th2`, LOREM.repeat(2)));
  }

  if (i % 3 === 0) {
    items.push(
      group(
        `${p}-g`,
        [
          exec(`${p}-e1`, 'ls -la src', 'a.ts\nb.ts\nc.ts'),
          exec(`${p}-e2`, 'pnpm exec vitest run', '✓ 42 passed'),
          read(`${p}-r1`, 'src/ChatRoot.tsx'),
        ],
        'Ran 2 commands, read a file'
      )
    );
  } else if (i % 3 === 1) {
    items.push(exec(`${p}-e`, 'git status --short', ' M src/a.ts\n M src/b.ts\n?? src/c.ts'));
    items.push(modify(`${p}-m`, 'src/a.ts'));
  } else {
    items.push(read(`${p}-r`, 'packages/chat-ui/src/components/engine/UnitRow.tsx'));
  }

  if (i % 5 === 2) items.push(subagent(`${p}-sa`, `Araştırmacı ${i}`));
  if (i % 5 === 4) items.push(unknownTool(`${p}-ws`, 'WebSearch'));
  if (i % 7 === 3) items.push(widget(`${p}-w`));
  if (i % 13 === 5) items.push(resourceLink(`${p}-rl`));
  if (i % 17 === 9) items.push(handoff(`${p}-ho`));

  const media =
    i % 6 === 1
      ? `\n\nÇıktılar:\n\n- /work/out/${p}-shot-1.png\n- /work/out/${p}-shot-2.png\n- /work/out/${p}-shot-3.png\n`
      : i % 6 === 4
        ? `\n\nVideo hazır: /work/out/${p}-clip.mp4 ve ses: /work/out/${p}-voice.mp3\n`
        : i % 6 === 5
          ? `\n\nGörsel: /work/out/${p}-single.png\n`
          : '';
  const reply =
    i % 4 === 0
      ? `## Özet ${i}\n\n${LOREM}\n\n- birinci madde\n- ikinci madde **kalın**\n- üçüncü \`kod\`\n\n${CODE}\n\n${LOREM}${media}`
      : `${LOREM.repeat(2 + (i % 3))}${media}`;
  items.push(assistant(`${p}-a`, reply));
  return items;
}

/** `count` turluk karışık döküm. Bazı turlar hata/iptal sonucu ve plan taşır. */
export function mixedTranscript(count: number): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (let i = 0; i < count; i += 1) {
    const items = turnItems(i);
    if (i % 10 === 7) {
      items.push({
        kind: 'plan',
        id: `t${i}-plan`,
        entries: [
          { content: 'Kaydırmayı yeniden üret', status: 'completed', priority: 'high' },
          { content: 'Kök nedeni bul', status: 'in_progress', priority: 'high' },
          { content: 'Düzelt ve test yaz', status: 'pending', priority: 'medium' },
        ],
      } as unknown as Item);
    }
    turns.push({
      id: `turn-${i}`,
      seq: i,
      initiator: 'user',
      items,
      ...(i % 9 === 8
        ? { outcome: { kind: 'error' as const, message: 'İşlem yarıda kaldı.' } }
        : i % 11 === 10
          ? { outcome: { kind: 'cancelled' as const } }
          : {}),
    } as TranscriptTurn);
  }
  return turns;
}

/** 1×1 PNG; görsel kartın gerçek bir decode yapması için. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Ev sahibi komutları: dosyalar var, görseller kısa bir gecikmeyle (eşzamansız) çözülür,
 * video/ses hiç çözülmez (yer tutucu kalır). Sistem bildirimi önekli mesajları yakalar.
 */
export function fixtureCommands(opts: { mediaDelayMs?: number } = {}): ChatCommands {
  const delay = opts.mediaDelayMs ?? 30;
  return {
    artifactExists: async () => true,
    mediaUrlForArtifact: (artifact, options) => {
      if (/\.(png|jpe?g|webp|gif)$/i.test(artifact.uri)) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ url: PIXEL }), delay);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return new Promise(() => undefined);
    },
    resolveArtifact: () => new Promise(() => undefined),
    systemNotice: (message) =>
      message.text.startsWith(SYSTEM_NOTICE_PREFIX) ? { label: 'Bağlam devredildi' } : null,
  };
}

export type Mounted = {
  host: HTMLElement;
  scrollEl: HTMLElement;
  state: ChatState;
  view: ChatView;
  dispose: () => void;
};

export function mountTranscript(opts: {
  width: number;
  height: number;
  turns: TranscriptTurn[];
  commands?: ChatCommands;
  composer?: 'slot' | 'none';
}): Mounted {
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed(opts.turns);
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:0;left:0;width:${opts.width}px;height:${opts.height}px;`;
  document.body.appendChild(host);
  const view = createChatView({
    context,
    state,
    parent: host,
    commands: opts.commands ?? fixtureCommands(),
    composer: opts.composer ?? 'none',
    stickToBottom: true,
  });
  const scrollEl = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  return {
    host,
    scrollEl,
    state,
    view,
    dispose: () => {
      view.dispose();
      state.dispose();
      context.dispose();
      host.remove();
    },
  };
}

export const paint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** scrollTop art arda `frames` kare boyunca değişmeyene kadar bekler. */
export async function waitStill(el: HTMLElement, frames = 4, maxFrames = 120): Promise<void> {
  let last = el.scrollTop;
  let still = 0;
  for (let i = 0; i < maxFrames && still < frames; i += 1) {
    await paint();
    if (el.scrollTop === last) still += 1;
    else {
      still = 0;
      last = el.scrollTop;
    }
  }
}

/** Görünür satır sarmalayıcıları (birim kimliği, türü, ekrandaki üst kenarı ve yüksekliği). */
export function visibleRows(host: HTMLElement) {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-unit-id]')).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      id: el.dataset.unitId!,
      kind: el.dataset.unitKind!,
      index: Number(el.dataset.index),
      top: rect.top,
      height: el.offsetHeight,
      el,
    };
  });
}

/**
 * Görüş alanında `y` noktasının altındaki satır ve o satırın ekrandaki üst kenarı. Kaydırma
 * sonrası aynı satırın ne kadar hareket ettiğini ölçmek için kullanılır.
 */
export function rowAt(host: HTMLElement, scrollEl: HTMLElement, y: number) {
  const box = scrollEl.getBoundingClientRect();
  const target = box.top + y;
  const rows = visibleRows(host).filter((r) => r.top <= target && r.top + r.height > target);
  rows.sort((a, b) => a.index - b.index);
  return rows[0];
}

/** Gerçek tekerlek girdisi (Playwright mouse.wheel) gönderir. */
export async function wheel(scrollEl: HTMLElement, deltaY: number): Promise<void> {
  await userEvent.wheel(scrollEl, { delta: { y: deltaY } });
}
