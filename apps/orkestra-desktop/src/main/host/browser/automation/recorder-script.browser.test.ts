import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { PageElement, PageEvent, PageWindow } from './page-dom';
import { PAGE_AGENT_VERSION, pageAgent } from './page-script';
import { pageRecorder, parseRecorderMessage, RECORDER_MESSAGE_PREFIX } from './recorder-script';

// Kayıt betiği gerçek DOM'da, Playwright'ın güvenilir (trusted) girdisiyle sınanır.
type RecorderTestWindow = Parameters<typeof pageRecorder>[0] & {
  __orkestraPageAgent?: unknown;
  document: PageWindow['document'] & { body: { innerHTML: string } };
};

const win = globalThis as unknown as RecorderTestWindow;
const NONCE = 'test-nonce';

function start(): void {
  pageRecorder(win, NONCE, RECORDER_MESSAGE_PREFIX, PAGE_AGENT_VERSION, pageAgent, 'start');
}

function stop(): string[] {
  return pageRecorder(win, NONCE, RECORDER_MESSAGE_PREFIX, PAGE_AGENT_VERSION, pageAgent, 'stop');
}

// Ana süreç programında DOM kütüphanesi yok; öğelere yapısal tiplerle erişilir.
function el(selector: string): PageElement {
  const found = win.document.querySelectorAll(selector)[0];
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

/** userEvent DOM öğesi bekler; gerçek DOM öğesi yapısal tipten çevrilir. */
type UserEventTarget = Parameters<typeof userEvent.click>[0];
function target(selector: string): UserEventTarget {
  return el(selector) as unknown as UserEventTarget;
}

const SyntheticMouseEvent = (
  globalThis as unknown as {
    MouseEvent: new (type: string, init: { bubbles: boolean }) => PageEvent;
  }
).MouseEvent;

let messages: string[] = [];

beforeEach(() => {
  win.__orkestraPageAgent = undefined;
  messages = [];
  vi.spyOn(console, 'debug').mockImplementation((message: unknown) => {
    messages.push(String(message));
  });
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
  win.document.body.innerHTML = '';
});

function steps(raw: string[] = messages) {
  return raw.map((message) => {
    const parsed = parseRecorderMessage(message, NONCE);
    if (!parsed || parsed === 'stale') throw new Error(`bad message ${message}`);
    return parsed.step;
  });
}

describe('page recorder', () => {
  // Playwright <select> seçimini betik olaylarıyla yapar (isTrusted=false); seçim adımı burada
  // sınanamaz, gerçek kullanıcı seçimi güvenilir change olayı üretir.
  it('records trusted clicks, typing and key presses with locators', async () => {
    win.document.body.innerHTML = `
      <input name="q" aria-label="Search">
      <button id="go">Go</button>`;
    start();

    await userEvent.click(target('input[name="q"]'));
    await userEvent.keyboard('shoes');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(target('#go'));

    expect(steps()).toEqual([
      { action: 'click', target: { selector: 'input[name="q"]', text: 'Search' } },
      {
        action: 'type',
        target: { selector: 'input[name="q"]', text: 'Search' },
        text: 'shoes',
        clear: true,
      },
      { action: 'press', key: 'Enter' },
      { action: 'click', target: { selector: '#go', text: 'Go' } },
    ]);
  });

  it('never records password values and returns pending typing when stopped', async () => {
    win.document.body.innerHTML = '<input type="password" name="pw" aria-label="Password">';
    start();
    await userEvent.click(target('input'));
    await userEvent.keyboard('hunter2');

    const flushed = steps(stop());

    expect(flushed).toEqual([
      {
        action: 'type',
        target: { selector: 'input[name="pw"]', text: 'Password' },
        text: '',
        clear: true,
        secret: true,
      },
    ]);
    expect(messages.join('\n')).not.toContain('hunter2');
  });

  it('ignores untrusted events dispatched by the page', () => {
    win.document.body.innerHTML = '<button id="fake">Fake</button>';
    start();
    el('#fake').dispatchEvent(new SyntheticMouseEvent('click', { bubbles: true }));
    expect(messages).toEqual([]);
  });
});
