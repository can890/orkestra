import { beforeEach, describe, expect, it } from 'vitest';
import type { PageDocument, PageElement, PageShadowRoot, PageWindow } from './page-dom';
import {
  PAGE_AGENT_VERSION,
  pageAgent,
  type PageCommandKind,
  type PageCommandOf,
  type PageOutput,
} from './page-script';

// Ana süreç programında DOM kütüphanesi yok; gerçek DOM'a yapısal tiplerle erişilir.
type FixtureShadowRoot = PageShadowRoot & { innerHTML: string };
type FixtureElement = PageElement & {
  innerHTML: string;
  attachShadow(init: { mode: 'open' }): FixtureShadowRoot;
  addEventListener(type: string, listener: () => void): void;
};
type FixtureWindow = PageWindow & {
  __orkestraPageAgent?: unknown;
  scrollTo(x: number, y: number): void;
  document: PageDocument & { body: FixtureElement };
};

const win = globalThis as unknown as FixtureWindow;

function mount(html: string): void {
  win.document.body.innerHTML = html;
  win.scrollTo(0, 0);
}

function byId(id: string): FixtureElement {
  // Fikstür öğeleri gerçek DOM öğeleridir; yapısal tip yalnızca kullandığımız üyeleri ekler.
  const el = win.document.getElementById(id) as FixtureElement | null;
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function run<K extends PageCommandKind>(command: PageCommandOf<K>): PageOutput<K> {
  const result = pageAgent(win, PAGE_AGENT_VERSION, command as Parameters<typeof pageAgent>[2]);
  if (!result.ok) throw new Error(result.error);
  return result.value as PageOutput<K>;
}

function runError(command: Parameters<typeof pageAgent>[2]): string {
  const result = pageAgent(win, PAGE_AGENT_VERSION, command);
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

function snapshot(options: { maxChars?: number; resetRefs?: boolean; refStart?: number } = {}) {
  return run({
    kind: 'snapshot',
    maxChars: options.maxChars ?? 12_000,
    resetRefs: options.resetRefs ?? false,
    refStart: options.refStart ?? 1,
  });
}

function refOf(outline: string, pattern: RegExp): string {
  const line = outline.split('\n').find((candidate) => pattern.test(candidate));
  const ref = line ? /\[ref=(e\d+)\]/.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`no ref for ${pattern} in\n${outline}`);
  return ref;
}

beforeEach(() => {
  win.__orkestraPageAgent = undefined;
  mount('');
});

describe('snapshot outline', () => {
  it('describes forms, links and their state with refs', () => {
    mount(`
      <nav aria-label="Main"><a href="/docs?x=1">Docs</a></nav>
      <h1>Sign in</h1>
      <form aria-label="Login">
        <label for="email">Email</label>
        <input id="email" type="email" value="a@b.test" placeholder="you@example.com" required>
        <label>Password <input type="password" value="hunter2"></label>
        <label><input type="checkbox" checked> Remember me</label>
        <select aria-label="Country"><option value="tr">Turkey</option><option value="de" selected>Germany</option></select>
        <textarea placeholder="About you"></textarea>
        <button type="submit" disabled>Send</button>
      </form>`);
    const { outline, truncated } = snapshot();
    expect(truncated).toBe(false);
    expect(outline).toMatch(/^URL: .+\nTitle: .*\nViewport: \d+x\d+ CSS px; scroll x=0 y=0/);
    expect(outline).toContain('- navigation "Main":');
    expect(outline).toMatch(/link "Docs" \[ref=e\d+\] -> \/docs\?x=1/);
    expect(outline).toContain('- heading "Sign in" [level=1]');
    expect(outline).toMatch(
      /textbox "Email" type=email value="a@b\.test" placeholder="you@example\.com" \[required\] \[ref=e\d+\]/
    );
    expect(outline).toMatch(/textbox "Password" type=password value=\(7 characters, hidden\)/);
    expect(outline).not.toContain('hunter2');
    expect(outline).toMatch(/checkbox "Remember me" \[checked\] \[ref=e\d+\]/);
    expect(outline).toMatch(
      /combobox "Country" value="Germany" \[ref=e\d+\] options: "Turkey", "Germany"/
    );
    expect(outline).toMatch(/textbox \[multiline\] placeholder="About you" \[ref=e\d+\]/);
    expect(outline).toMatch(/button "Send" \[disabled\] \[ref=e\d+\]/);
  });

  it('skips hidden elements but keeps visible children of visibility:hidden parents', () => {
    mount(`
      <button style="display:none">DisplayNone</button>
      <button style="visibility:hidden">VisHidden</button>
      <div aria-hidden="true"><button>AriaHidden</button></div>
      <button style="width:0;height:0;padding:0;border:0;overflow:hidden">ZeroSize</button>
      <div style="visibility:hidden">hidden text <button style="visibility:visible">Visible child</button></div>
      <p>Plain paragraph</p>`);
    const { outline } = snapshot();
    for (const hidden of ['DisplayNone', 'VisHidden', 'AriaHidden', 'ZeroSize', 'hidden text']) {
      expect(outline).not.toContain(hidden);
    }
    expect(outline).toMatch(/button "Visible child" \[ref=e\d+\]/);
    expect(outline).toContain('- text: Plain paragraph');
  });

  it('pierces open shadow roots and resolves refs inside them', () => {
    mount('<div id="host"></div>');
    const root = byId('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="inner" style="width:80px;height:30px">Shadow button</button>';
    const { outline } = snapshot();
    const ref = refOf(outline, /button "Shadow button"/);
    const located = run({ kind: 'locate', target: { ref }, purpose: 'click', scroll: true });
    expect(located.point.x).toBeGreaterThan(0);
    expect(located.point.y).toBeGreaterThan(0);
  });

  it('represents a visually hidden checkbox through its label', () => {
    mount(`<label id="lbl" style="display:inline-block;padding:4px">
      <input id="cb" type="checkbox" style="position:absolute;opacity:0;width:1px;height:1px"> Accept terms</label>`);
    const { outline } = snapshot();
    expect(outline).toMatch(/- checkbox "Accept terms" \[ref=e\d+\]/);
    expect(outline.match(/Accept terms/g)?.length).toBe(1);
  });

  it('renders open modal dialogs first and marks them', () => {
    mount('<button>Behind</button><dialog id="dlg"><h2>Confirm</h2><button>OK</button></dialog>');
    (byId('dlg') as FixtureElement & { showModal(): void }).showModal();
    const { outline } = snapshot();
    const lines = outline.split('\n');
    expect(outline).toContain('Note: a modal dialog is open');
    const dialogLine = lines.findIndex((line) => line.startsWith('- dialog "Confirm" [modal]:'));
    const behindLine = lines.findIndex((line) => line.includes('"Behind"'));
    expect(dialogLine).toBeGreaterThan(-1);
    expect(dialogLine).toBeLessThan(behindLine);
  });

  it('truncates long text runs and respects maxChars', () => {
    mount(`<p>${'word '.repeat(200)}</p>${'<button>Btn</button>'.repeat(200)}`);
    const full = snapshot();
    expect(full.outline).toMatch(/- text: (word ){40,}.*…/);
    const small = snapshot({ maxChars: 600 });
    expect(small.truncated).toBe(true);
    expect(small.outline.length).toBeLessThanOrEqual(600);
    expect(small.outline).toContain('snapshot truncated');
  });
});

describe('refs', () => {
  it('keeps refs stable across snapshots and renumbers after a reset', () => {
    mount('<button>One</button><button>Two</button>');
    const first = snapshot();
    const second = snapshot();
    expect(refOf(second.outline, /"Two"/)).toBe(refOf(first.outline, /"Two"/));
    const reset = snapshot({ resetRefs: true, refStart: 50 });
    expect(refOf(reset.outline, /"One"/)).toBe('e50');
    expect(reset.nextRef).toBe(52);
  });

  it('reports stale, removed and malformed refs', () => {
    mount('<button id="b">Gone soon</button>');
    const ref = refOf(snapshot().outline, /Gone soon/);
    byId('b').innerHTML = 'changed';
    mount('<p>other</p>');
    expect(runError({ kind: 'locate', target: { ref }, purpose: 'click', scroll: true })).toBe(
      `Element ref ${ref} not found; take a new snapshot.`
    );
    expect(
      runError({ kind: 'locate', target: { ref: 'button' }, purpose: 'click', scroll: true })
    ).toMatch(/Invalid element ref "button"/);
  });

  it('reports elements covered by an overlay and guards dropdown selects', () => {
    mount(`<button id="b" style="position:absolute;left:10px;top:10px;width:100px;height:30px">Target</button>
      <select aria-label="Pick" style="position:absolute;left:10px;top:60px"><option>a</option></select>
      <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>`);
    const { outline } = snapshot();
    expect(
      runError({
        kind: 'locate',
        target: { ref: refOf(outline, /"Target"/) },
        purpose: 'click',
        scroll: true,
      })
    ).toMatch(/is covered by <div#overlay>/);
    expect(
      runError({
        kind: 'locate',
        target: { ref: refOf(outline, /combobox "Pick"/) },
        purpose: 'click',
        scroll: true,
      })
    ).toMatch(/dropdown <select>; use selectOption/);
  });

  it('accepts viewport points and rejects points outside the viewport', () => {
    mount('<button style="position:absolute;left:0;top:0;width:50px;height:20px">P</button>');
    expect(
      run({ kind: 'locate', target: { x: 10, y: 10 }, purpose: 'click', scroll: false }).point
    ).toEqual({ x: 10, y: 10 });
    expect(
      runError({ kind: 'locate', target: { x: -1, y: 10 }, purpose: 'click', scroll: false })
    ).toMatch(/outside the viewport/);
  });
});

describe('select options', () => {
  it('selects by label or value and dispatches change', () => {
    mount(`<select id="s" aria-label="Country"><option value="tr">Turkey</option><option value="de">Germany</option>
      <option value="fr" disabled>France</option></select>`);
    let changes = 0;
    byId('s').addEventListener('change', () => {
      changes++;
    });
    const ref = refOf(snapshot().outline, /combobox "Country"/);
    expect(run({ kind: 'selectOption', target: { ref }, values: ['germany'] }).selected).toEqual([
      'de',
    ]);
    expect(run({ kind: 'selectOption', target: { ref }, values: ['tr'] }).selected).toEqual(['tr']);
    expect(changes).toBe(2);
    expect(runError({ kind: 'selectOption', target: { ref }, values: ['Spain'] })).toBe(
      `No option matching "Spain" in ${ref}. Available options: "Turkey" (value "tr"), "Germany" (value "de"), "France" (value "fr").`
    );
    expect(runError({ kind: 'selectOption', target: { ref }, values: ['France'] })).toMatch(
      /is disabled/
    );
    expect(runError({ kind: 'selectOption', target: { ref }, values: ['tr', 'de'] })).toMatch(
      /single selection/
    );
  });

  it('supports multiple selects', () => {
    mount(
      '<select multiple aria-label="Tags"><option>a</option><option>b</option><option>c</option></select>'
    );
    const ref = refOf(snapshot().outline, /listbox "Tags"/);
    expect(run({ kind: 'selectOption', target: { ref }, values: ['a', 'c'] }).selected).toEqual([
      'a',
      'c',
    ]);
  });
});

describe('editing helpers', () => {
  it('focuses targets, reports edit state, moves the caret and force-clears', () => {
    mount(
      '<input id="i" aria-label="Name" value="hello"><input id="d" type="date" aria-label="Day">'
    );
    const { outline } = snapshot();
    const ref = refOf(outline, /textbox "Name"/);
    const prepared = run({ kind: 'prepareType', target: { ref } });
    expect(prepared).toMatchObject({ focused: false, mode: 'text' });
    expect(prepared.point).not.toBeNull();
    expect(run({ kind: 'focus', target: { ref } }).focused).toBe(true);
    expect(run({ kind: 'editState' })).toMatchObject({ kind: 'input', empty: false });
    run({ kind: 'caretToEnd' });
    expect(byId('i').selectionStart).toBe(5);
    expect(run({ kind: 'forceClear' }).empty).toBe(true);
    expect(byId('i').value).toBe('');

    const dateRef = refOf(outline, /textbox "Day"/);
    expect(run({ kind: 'prepareType', target: { ref: dateRef } }).mode).toBe('value');
    expect(run({ kind: 'setValue', target: { ref: dateRef }, value: '2024-05-17' }).value).toBe(
      '2024-05-17'
    );
    expect(runError({ kind: 'setValue', target: { ref: dateRef }, value: 'soon' })).toMatch(
      /YYYY-MM-DD/
    );
  });

  it('matches visible text case-insensitively including shadow roots', () => {
    mount('<p>Hello World</p><div id="host"></div>');
    byId('host').attachShadow({ mode: 'open' }).innerHTML = '<span>Inside shadow</span>';
    expect(run({ kind: 'matchText', text: 'hello world', textGone: 'missing' })).toEqual({
      textFound: true,
      textGoneAbsent: true,
    });
    expect(run({ kind: 'matchText', text: 'inside SHADOW', textGone: null }).textFound).toBe(true);
    expect(run({ kind: 'text', maxChars: 5 })).toEqual({ text: 'Hello', truncated: true });
  });

  it('finds the scroll container under a target and scrolls it by script', () => {
    mount(
      '<div id="sc" style="height:60px;overflow:auto"><div style="height:500px"><button>In list</button></div></div>'
    );
    const ref = refOf(snapshot().outline, /"In list"/);
    const probe = run({ kind: 'scrollProbe', target: { ref }, direction: 'down' });
    expect(probe.position.y).toBe(0);
    expect(probe.defaultAmount).toBe(Math.round(byId('sc').clientHeight * 0.8));
    expect(run({ kind: 'scrollBy', direction: 'down', amount: 40 }).position.y).toBe(40);
    expect(byId('sc').scrollTop).toBe(40);
  });
});
