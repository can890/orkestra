import type {
  AgentBrowserPort,
  AgentBrowserTab,
  BrowserConsoleEntry,
  BrowserDialog,
  BrowserElementTarget,
  BrowserKeyModifier,
  BrowserNetworkRequest,
  BrowserPageAutomation,
  BrowserPageInfo,
} from '@core/primitives/browser/api/agent-browser';
import type { AgentToolCallResult } from '@core/services/agent-tools/api/agent-tools';
import type { BrowserToolName } from './browser-tool-definitions';
import type {
  BrowserToolScope,
  LoopbackForwarder,
  ResolvedBrowserUrl,
} from './loopback-forwarding';

/** Bir konuşmanın tarayıcı araçlarındaki durumu: kapsamı ve güncel sekmesi. */
export type BrowserToolSession = {
  readonly scope: BrowserToolScope;
  currentTab(): string | null;
  setCurrentTab(browserId: string | null): void;
};

export type BrowserToolTiming = {
  /** Sayfa yükleme bekleme süresi. */
  navigationTimeoutMs: number;
  /** Tek bir araç çağrısının üst sınırı (wait_for kendi süresine göre uzar). */
  callTimeoutMs: number;
  /** Yüklü olmayan bir sekme öne getirildikten sonra sayfasının hazır olmasını bekleme süresi. */
  pageReadyTimeoutMs: number;
  pageReadyPollMs: number;
};

export type BrowserToolRunnerDeps = {
  browser: AgentBrowserPort;
  urls: LoopbackForwarder;
  timing?: Partial<BrowserToolTiming>;
};

/** Ajana açıklanan, beklenen bir araç hatası (yanlış argüman, sekme yok…). */
export class BrowserToolError extends Error {}

type Args = Record<string, unknown>;

const DEFAULT_TIMING: BrowserToolTiming = {
  navigationTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
  pageReadyTimeoutMs: 10_000,
  pageReadyPollMs: 100,
};

const BLANK_URL = 'about:blank';
const DEFAULT_SNAPSHOT_CHARS = 40_000;
const EXCERPT_CHARS = 3_000;
const DEFAULT_TEXT_CHARS = 20_000;
const MAX_VALUE_CHARS = 20_000;
const MAX_CONSOLE_MESSAGE_CHARS = 2_000;
const DEFAULT_CONSOLE_LIMIT = 50;
const DEFAULT_NETWORK_LIMIT = 50;
const MAX_NETWORK_LIMIT = 500;
const DEFAULT_BODY_CHARS = 20_000;
const MAX_BODY_CHARS = 200_000;
const MAX_HEADER_LINES = 60;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 120;
const WAIT_MARGIN_MS = 15_000;
const ID_LIMIT = 200;
const URL_LIMIT = 8_192;
const TEXT_LIMIT = 100_000;
const MODIFIERS = [
  'shift',
  'control',
  'alt',
  'meta',
] as const satisfies readonly BrowserKeyModifier[];

/**
 * Tarayıcı araçlarının uygulaması. Her araç, verilmezse konuşmanın güncel sekmesinde çalışır:
 * ajanın en son açtığı, seçtiği ya da kullandığı sekme; yoksa görevin panelinde gösterilen sekme.
 * Başka bir görevin sekmesi bu görevde yokmuş gibi davranır.
 */
export class BrowserToolRunner {
  private readonly timing: BrowserToolTiming;

  constructor(private readonly deps: BrowserToolRunnerDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  async run(session: BrowserToolSession, name: string, args: Args): Promise<AgentToolCallResult> {
    const timeoutMs = this.timeoutFor(name, args);
    try {
      return await withTimeout(
        this.dispatch(session, name, args),
        timeoutMs,
        `The in-app browser did not finish ${name} within ${Math.round(timeoutMs / 1000)} seconds.`
      );
    } catch (error) {
      return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
    }
  }

  private dispatch(session: BrowserToolSession, name: string, args: Args) {
    switch (name as BrowserToolName) {
      case 'tabs':
        return this.listTabs(session);
      case 'open_tab':
        return this.openTab(session, args);
      case 'select_tab':
        return this.selectTab(session, args);
      case 'close_tab':
        return this.closeTab(session, args);
      case 'navigate':
        return this.navigate(session, args);
      case 'snapshot':
        return this.snapshot(session, args);
      case 'click':
        return this.click(session, args);
      case 'hover':
        return this.hover(session, args);
      case 'type':
        return this.typeText(session, args);
      case 'press_key':
        return this.pressKey(session, args);
      case 'scroll':
        return this.scroll(session, args);
      case 'select_option':
        return this.selectOption(session, args);
      case 'wait_for':
        return this.waitFor(session, args);
      case 'screenshot':
        return this.screenshot(session, args);
      case 'get_text':
        return this.getText(session, args);
      case 'console':
        return this.readConsole(session, args);
      case 'evaluate':
        return this.evaluate(session, args);
      case 'handle_dialog':
        return this.handleDialog(session, args);
      case 'network_requests':
        return this.networkRequests(session, args);
      case 'network_response':
        return this.networkResponse(session, args);
      default:
        return Promise.reject(new BrowserToolError(`Unknown tool: ${name}`));
    }
  }

  // ── Sekmeler ────────────────────────────────────────────────────────────────

  private async listTabs(session: BrowserToolSession): Promise<AgentToolCallResult> {
    const tabs = this.tabsOf(session.scope);
    if (tabs.length === 0) {
      return text(['No browser tabs are open in this task. Call open_tab to open one.']);
    }
    const current = session.currentTab();
    const lines = await Promise.all(
      tabs.map(async (tab) => {
        const marks = [
          tab.browserId === current ? 'current' : null,
          tab.active ? 'shown' : null,
          tab.live ? null : 'not loaded',
        ].filter((mark): mark is string => mark !== null);
        const url = await this.deps.urls.describe(tab.url, session.scope);
        return `- ${tab.browserId}${marks.length ? ` [${marks.join(', ')}]` : ''}: ${titleOf(tab)} — ${url}`;
      })
    );
    return text([
      `${count(tabs.length, 'tab')} open in this task (current = your default tab, shown = visible in the browser panel):`,
      ...lines,
    ]);
  }

  private async openTab(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const rawUrl = optionalString(args, 'url', URL_LIMIT)?.trim() || undefined;
    const activate = optionalBoolean(args, 'activate') ?? true;
    // Adres sekme açılmadan çözülür; geçersiz adres boş bir sekme bırakmasın.
    const target = rawUrl ? await this.deps.urls.resolve(rawUrl, session.scope) : null;
    const { projectId, workspaceId, taskId } = session.scope;
    const tab = await this.deps.browser.openTab({ projectId, workspaceId, taskId, activate });
    session.setCurrentTab(tab.browserId);
    const lines = [
      `Opened tab ${tab.browserId} as your current tab${activate ? ', shown in the browser panel' : ''}.`,
    ];
    if (!target || target.url === BLANK_URL) {
      lines.push(await this.pageSummary(session, tab));
      return text(lines);
    }
    const note = forwardNote(target);
    if (note) lines.push(note);
    const page = await this.pageOf(tab);
    const info = await this.load(page, target, lines);
    lines.push(await this.pageSummary(session, info));
    return text(withExcerpt(lines, await this.excerpt(page)));
  }

  private async selectTab(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const tab = this.ownTab(session.scope, requiredString(args, 'tab', ID_LIMIT).trim());
    await this.deps.browser.activateTab(tab.browserId);
    session.setCurrentTab(tab.browserId);
    return text([
      `Tab ${tab.browserId} is now your current tab and is shown in the browser panel.`,
      await this.pageSummary(session, this.deps.browser.getTab(tab.browserId) ?? tab),
    ]);
  }

  private async closeTab(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const tab = this.ownTab(session.scope, requiredString(args, 'tab', ID_LIMIT).trim());
    await this.deps.browser.closeTab(tab.browserId);
    const wasCurrent = session.currentTab() === tab.browserId;
    if (wasCurrent) session.setCurrentTab(null);
    const remaining = this.tabsOf(session.scope).filter(
      (candidate) => candidate.browserId !== tab.browserId
    ).length;
    const lines = [`Closed tab ${tab.browserId}.`];
    if (remaining === 0) lines.push('No tabs are open in this task now.');
    else {
      lines.push(`${count(remaining, 'tab')} still open in this task.`);
      if (wasCurrent) {
        lines.push('Your next calls use the tab shown in the browser panel unless you pass tab.');
      }
    }
    return text(lines);
  }

  // ── Sayfa ───────────────────────────────────────────────────────────────────

  private async navigate(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const rawUrl = optionalString(args, 'url', URL_LIMIT)?.trim() || undefined;
    const action = optionalEnum(args, 'action', ['back', 'forward', 'reload'] as const);
    if (rawUrl && action) throw new BrowserToolError('Pass either url or action, not both.');
    if (!rawUrl && !action) {
      throw new BrowserToolError('Pass url, or action: back, forward or reload.');
    }
    const tab = this.targetTab(session, args);
    const target = rawUrl ? await this.deps.urls.resolve(rawUrl, session.scope) : null;
    const page = await this.pageOf(tab);
    const lines: string[] = [];
    let info: BrowserPageInfo;
    if (target) {
      const note = forwardNote(target);
      if (note) lines.push(note);
      info = await this.load(page, target, lines);
      lines.unshift(`Loaded the page in tab ${tab.browserId}.`);
    } else if (action === 'back') {
      info = await page.goBack();
      lines.push('Went back.');
    } else if (action === 'forward') {
      info = await page.goForward();
      lines.push('Went forward.');
    } else {
      info = await page.reload();
      lines.push('Reloaded the page.');
    }
    lines.push(await this.pageSummary(session, info));
    return text(withExcerpt(lines, await this.excerpt(page)));
  }

  private async snapshot(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const maxChars =
      optionalNumber(args, 'maxChars', { min: 500, max: 200_000, integer: true }) ??
      DEFAULT_SNAPSHOT_CHARS;
    const page = await this.pageOf(this.targetTab(session, args));
    const snapshot = await page.snapshot({ maxChars });
    if (snapshot.dialog) {
      return text([await this.pageSummary(session, snapshot), '', snapshot.outline]);
    }
    return text([
      await this.pageSummary(session, snapshot),
      '',
      snapshot.outline.trim() ? snapshot.outline : '(The page has no visible content.)',
      ...(snapshot.truncated
        ? [`[Truncated at ${maxChars} characters; pass a larger maxChars to see more.]`]
        : []),
    ]);
  }

  private async click(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const target = elementTarget(args, true);
    const button = optionalEnum(args, 'button', ['left', 'right', 'middle'] as const);
    const double = optionalBoolean(args, 'double') ?? false;
    const modifiers = optionalEnumArray(args, 'modifiers', MODIFIERS);
    const tab = this.targetTab(session, args);
    const page = await this.pageOf(tab);
    await page.click(target, {
      ...(button ? { button } : {}),
      clickCount: double ? 2 : 1,
      ...(modifiers.length > 0 ? { modifiers } : {}),
    });
    const verb = double
      ? 'Double-clicked'
      : button === 'right'
        ? 'Right-clicked'
        : button === 'middle'
          ? 'Middle-clicked'
          : 'Clicked';
    return this.afterAction(session, tab, `${verb} ${describeTarget(target)}.`);
  }

  private async hover(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const target = elementTarget(args, true);
    const page = await this.pageOf(this.targetTab(session, args));
    await page.hover(target);
    return text([`Hovering over ${describeTarget(target)}.`]);
  }

  private async typeText(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const value = requiredString(args, 'text', TEXT_LIMIT, { allowEmpty: true });
    const ref = optionalRef(args);
    const clear = optionalBoolean(args, 'clear') ?? false;
    const submit = optionalBoolean(args, 'submit') ?? false;
    const tab = this.targetTab(session, args);
    const page = await this.pageOf(tab);
    await page.type(ref ? { ref } : null, value, { clear, submit });
    const line = `Typed ${count(value.length, 'character')} into ${ref ? `[ref=${ref}]` : 'the focused element'}${clear ? ', replacing its value' : ''}${submit ? ', then pressed Enter' : ''}.`;
    return submit ? this.afterAction(session, tab, line) : text([line]);
  }

  private async pressKey(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const key = requiredString(args, 'key', 100).trim();
    const tab = this.targetTab(session, args);
    const page = await this.pageOf(tab);
    await page.pressKey(key);
    return this.afterAction(session, tab, `Pressed ${key}.`);
  }

  private async scroll(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const ref = optionalRef(args);
    const direction =
      optionalEnum(args, 'direction', ['up', 'down', 'left', 'right'] as const) ?? 'down';
    const amount = optionalNumber(args, 'amount', { min: 1, max: 1_000_000 });
    const page = await this.pageOf(this.targetTab(session, args));
    await page.scroll({
      ...(ref ? { target: { ref } } : {}),
      direction,
      ...(amount !== undefined ? { amount } : {}),
    });
    return text([
      `Scrolled ${direction} ${amount !== undefined ? `${amount} px` : 'by about one screen'}${ref ? ` in [ref=${ref}]` : ''}.`,
    ]);
  }

  private async selectOption(
    session: BrowserToolSession,
    args: Args
  ): Promise<AgentToolCallResult> {
    const ref = optionalRef(args);
    if (!ref) throw new BrowserToolError('"ref" is required: the <select> element from snapshot.');
    const values = requiredStringArray(args, 'values');
    const page = await this.pageOf(this.targetTab(session, args));
    const selected = await page.selectOption({ ref }, values);
    if (selected.length === 0) {
      throw new BrowserToolError(
        `No option of [ref=${ref}] matched ${values.map((value) => JSON.stringify(value)).join(', ')}.`
      );
    }
    return text([
      `Selected in [ref=${ref}]: ${selected.map((value) => JSON.stringify(value)).join(', ')}.`,
    ]);
  }

  private async waitFor(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const appear = optionalString(args, 'text', TEXT_LIMIT) || undefined;
    const gone = optionalString(args, 'textGone', TEXT_LIMIT) || undefined;
    const seconds = optionalNumber(args, 'seconds', { min: 0, max: 60 });
    if (!appear && !gone && seconds === undefined) {
      throw new BrowserToolError('Pass text, textGone or seconds.');
    }
    const timeoutSeconds =
      optionalNumber(args, 'timeoutSeconds', { min: 1, max: MAX_WAIT_SECONDS }) ??
      DEFAULT_WAIT_SECONDS;
    const tab = this.targetTab(session, args);
    const page = await this.pageOf(tab);
    const { satisfied } = await page.waitFor({
      ...(appear ? { text: appear } : {}),
      ...(gone ? { textGone: gone } : {}),
      ...(seconds !== undefined ? { timeMs: seconds * 1000 } : {}),
      timeoutMs: timeoutSeconds * 1000,
    });
    const conditions = [
      ...(appear ? [`"${appear}" is visible`] : []),
      ...(gone ? [`"${gone}" is gone`] : []),
    ];
    const line =
      conditions.length === 0
        ? `Waited ${seconds} s.`
        : satisfied
          ? `Done: ${conditions.join(' and ')}.`
          : `Timed out after ${timeoutSeconds} s waiting until ${conditions.join(' and ')}.`;
    const summary = await this.tabSummary(session, tab.browserId);
    return text(summary ? [line, summary] : [line]);
  }

  private async screenshot(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const fullPage = optionalBoolean(args, 'fullPage') ?? false;
    const tab = this.targetTab(session, args);
    const page = await this.pageOf(tab);
    const shot = await page.screenshot({ fullPage });
    const info = this.deps.browser.getTab(tab.browserId) ?? tab;
    const url = await this.deps.urls.describe(info.url, session.scope);
    return {
      content: [
        {
          type: 'text',
          text: `Screenshot of ${url} — ${titleOf(info)} (${shot.width}×${shot.height} px, ${fullPage ? 'full page' : 'visible area'}).`,
        },
        { type: 'image', data: shot.data, mimeType: shot.mimeType },
      ],
    };
  }

  private async getText(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const maxChars =
      optionalNumber(args, 'maxChars', { min: 500, max: 200_000, integer: true }) ??
      DEFAULT_TEXT_CHARS;
    const tab = this.targetTab(session, args);
    const page = await this.pageOf(tab);
    const result = await page.getText({ maxChars });
    const summary = await this.tabSummary(session, tab.browserId);
    return text([
      ...(summary ? [summary, ''] : []),
      result.text.trim() ? result.text : '(The page has no visible text.)',
      ...(result.truncated
        ? [`[Truncated at ${maxChars} characters; pass a larger maxChars to see more.]`]
        : []),
    ]);
  }

  private async readConsole(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const limit =
      optionalNumber(args, 'limit', { min: 1, max: 500, integer: true }) ?? DEFAULT_CONSOLE_LIMIT;
    const clear = optionalBoolean(args, 'clear') ?? false;
    const page = await this.pageOf(this.targetTab(session, args));
    // Sıra ve sınır motorun sıralamasından bağımsız olsun: eskiden yeniye, en yeniler kalır.
    const entries = [...page.consoleMessages({ limit, clear })]
      .sort((left, right) => left.time - right.time)
      .slice(-limit);
    const cleared = clear ? ['Console buffer cleared.'] : [];
    if (entries.length === 0) return text(['No console messages.', ...cleared]);
    return text([
      `${count(entries.length, 'console message')}, oldest first:`,
      ...entries.map(formatConsoleEntry),
      ...cleared,
    ]);
  }

  private async handleDialog(
    session: BrowserToolSession,
    args: Args
  ): Promise<AgentToolCallResult> {
    const accept = optionalBoolean(args, 'accept');
    if (accept === undefined) {
      throw new BrowserToolError('"accept" is required: true to accept (OK), false to dismiss.');
    }
    const promptText = optionalString(args, 'promptText', TEXT_LIMIT);
    const tab = this.targetTab(session, args);
    const page = await this.pageOf(tab);
    if (!page.handleDialog) {
      throw new BrowserToolError('This tab does not support handling JavaScript dialogs.');
    }
    const dialog = await page.handleDialog({
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    const verb =
      dialog.type === 'alert' ? 'Dismissed' : accept ? 'Accepted' : 'Dismissed (cancelled)';
    const typed =
      dialog.type === 'prompt' && accept && promptText !== undefined
        ? ` with ${JSON.stringify(promptText)}`
        : '';
    return this.afterAction(
      session,
      tab,
      `${verb} the ${dialog.type} dialog ${JSON.stringify(dialog.message)}${typed}.`
    );
  }

  private async networkRequests(
    session: BrowserToolSession,
    args: Args
  ): Promise<AgentToolCallResult> {
    const filter = optionalString(args, 'filter', URL_LIMIT)?.trim() || undefined;
    const failedOnly = optionalBoolean(args, 'failedOnly') ?? false;
    const limit =
      optionalNumber(args, 'limit', { min: 1, max: MAX_NETWORK_LIMIT, integer: true }) ??
      DEFAULT_NETWORK_LIMIT;
    const clear = optionalBoolean(args, 'clear') ?? false;
    const page = await this.pageOf(this.targetTab(session, args));
    if (!page.networkRequests) {
      throw new BrowserToolError('Network inspection is not available for this tab.');
    }
    const entries = page.networkRequests({
      ...(filter ? { filter } : {}),
      failedOnly,
      limit,
      clear,
    });
    const cleared = clear ? ['Network log cleared.'] : [];
    const scope = [filter ? `matching "${filter}"` : null, failedOnly ? 'failed' : null]
      .filter(Boolean)
      .join(', ');
    if (entries.length === 0) {
      return text([
        `No network requests${scope ? ` (${scope})` : ''} recorded. Requests are recorded from the first time you use a tab; reload the page to capture its initial requests.`,
        ...cleared,
      ]);
    }
    const lines = await Promise.all(entries.map((entry) => this.formatRequest(session, entry)));
    return text([
      `${count(entries.length, 'network request')}${scope ? ` (${scope})` : ''}, oldest first. Pass a requestId to network_response for headers and the response body:`,
      ...lines,
      ...cleared,
    ]);
  }

  private async networkResponse(
    session: BrowserToolSession,
    args: Args
  ): Promise<AgentToolCallResult> {
    const requestId = requiredString(args, 'requestId', ID_LIMIT).trim();
    const maxChars =
      optionalNumber(args, 'maxChars', { min: 100, max: MAX_BODY_CHARS, integer: true }) ??
      DEFAULT_BODY_CHARS;
    const page = await this.pageOf(this.targetTab(session, args));
    if (!page.networkResponse) {
      throw new BrowserToolError('Network inspection is not available for this tab.');
    }
    const detail = await page.networkResponse(requestId, { maxChars });
    const lines = [
      await this.formatRequest(session, detail.request),
      '',
      'Request headers:',
      ...formatHeaders(detail.requestHeaders),
      '',
      'Response headers:',
      ...formatHeaders(detail.responseHeaders),
      '',
    ];
    if (detail.body) {
      lines.push(
        detail.body.text ? 'Response body:' : 'Response body: (empty)',
        ...(detail.body.text ? [detail.body.text] : []),
        ...(detail.body.truncated
          ? [`[Truncated at ${maxChars} characters; pass a larger maxChars to see more.]`]
          : [])
      );
    } else {
      lines.push(`Response body not returned: ${detail.bodyUnavailable ?? 'unavailable'}`);
    }
    return text(lines);
  }

  private async formatRequest(
    session: BrowserToolSession,
    entry: BrowserNetworkRequest
  ): Promise<string> {
    const url = await this.deps.urls.describe(entry.url, session.scope);
    const outcome =
      entry.state === 'failed'
        ? `FAILED ${entry.failure ?? ''}`.trim()
        : entry.status !== undefined
          ? String(entry.status)
          : entry.state === 'pending'
            ? 'pending'
            : 'done';
    const details = [
      entry.durationMs !== undefined ? `${entry.durationMs} ms` : null,
      entry.encodedSize !== undefined ? formatBytes(entry.encodedSize) : null,
      entry.fromCache ? 'cache' : null,
      entry.mimeType ?? null,
    ].filter((item): item is string => item !== null);
    return `- [${entry.requestId}] ${entry.method} ${outcome} ${entry.resourceType.toLowerCase()} ${url}${details.length ? ` (${details.join(', ')})` : ''}`;
  }

  private async evaluate(session: BrowserToolSession, args: Args): Promise<AgentToolCallResult> {
    const expression = requiredString(args, 'expression', TEXT_LIMIT);
    const page = await this.pageOf(this.targetTab(session, args));
    return text([formatValue(await page.evaluate(expression))]);
  }

  // ── Yardımcılar ─────────────────────────────────────────────────────────────

  private tabsOf(scope: BrowserToolScope): AgentBrowserTab[] {
    return this.deps.browser.listTabs({ projectId: scope.projectId, taskId: scope.taskId });
  }

  /** Görevin bir sekmesi; başka görevin sekmesi bulunmamış sayılır. */
  private ownTab(scope: BrowserToolScope, browserId: string): AgentBrowserTab {
    const tab = this.deps.browser.getTab(browserId);
    if (!tab || !inScope(tab, scope)) {
      throw new BrowserToolError(
        `Tab "${browserId}" is not open in this task. Call tabs to list the open tabs.`
      );
    }
    return tab;
  }

  /**
   * Aracın hedef sekmesi: verilen sekme, yoksa güncel sekme, yoksa panelde gösterilen sekme.
   * Kullanılan sekme konuşmanın güncel sekmesi olur.
   */
  private targetTab(session: BrowserToolSession, args: Args): AgentBrowserTab {
    const requested = optionalString(args, 'tab', ID_LIMIT)?.trim();
    if (requested) {
      const tab = this.ownTab(session.scope, requested);
      session.setCurrentTab(tab.browserId);
      return tab;
    }
    const current = session.currentTab();
    if (current) {
      const tab = this.deps.browser.getTab(current);
      if (tab && inScope(tab, session.scope)) return tab;
      session.setCurrentTab(null);
    }
    const tabs = this.tabsOf(session.scope);
    const shown = tabs.find((tab) => tab.active);
    if (shown) {
      session.setCurrentTab(shown.browserId);
      return shown;
    }
    if (tabs.length === 0) {
      throw new BrowserToolError('No browser tab is open in this task. Call open_tab to open one.');
    }
    throw new BrowserToolError(
      `You have no current tab. Pass tab or call select_tab with one of: ${tabs
        .map((tab) => `${tab.browserId} (${titleOf(tab)})`)
        .join(', ')}.`
    );
  }

  /** Sekmenin sayfa kontrolcüsü; sayfa yüklü değilse sekme öne getirilip yüklenmesi beklenir. */
  private async pageOf(tab: AgentBrowserTab): Promise<BrowserPageAutomation> {
    const ready = this.deps.browser.page(tab.browserId);
    if (ready) return ready;
    await this.deps.browser.activateTab(tab.browserId);
    const deadline = Date.now() + this.timing.pageReadyTimeoutMs;
    for (;;) {
      const page = this.deps.browser.page(tab.browserId);
      if (page) return page;
      if (Date.now() >= deadline) {
        throw new BrowserToolError(
          `Tab ${tab.browserId} is not loaded. Call select_tab to show it, then try again.`
        );
      }
      await delay(this.timing.pageReadyPollMs);
    }
  }

  private async load(
    page: BrowserPageAutomation,
    target: ResolvedBrowserUrl,
    context: string[]
  ): Promise<BrowserPageInfo> {
    try {
      return await page.navigate(target.url, { timeoutMs: this.timing.navigationTimeoutMs });
    } catch (error) {
      const hint = target.forward
        ? ` Check that a server is listening on port ${target.forward.remotePort} of the workspace host.`
        : '';
      throw new BrowserToolError(
        [...context, `Loading ${target.url} failed: ${errorMessage(error)}.${hint}`].join('\n')
      );
    }
  }

  private async afterAction(
    session: BrowserToolSession,
    tab: AgentBrowserTab,
    line: string
  ): Promise<AgentToolCallResult> {
    const summary = await this.tabSummary(session, tab.browserId);
    const dialog = this.deps.browser.page(tab.browserId)?.dialog?.() ?? null;
    return text([
      line,
      ...(summary ? [summary] : []),
      dialog ? dialogNotice(dialog) : 'Take a snapshot to see the updated page and get fresh refs.',
    ]);
  }

  private async tabSummary(session: BrowserToolSession, browserId: string): Promise<string | null> {
    const tab = this.deps.browser.getTab(browserId);
    return tab ? this.pageSummary(session, tab) : null;
  }

  private async pageSummary(session: BrowserToolSession, info: BrowserPageInfo): Promise<string> {
    const url = await this.deps.urls.describe(info.url, session.scope);
    return `URL: ${url}\nTitle: ${info.title || '(untitled)'}`;
  }

  private async excerpt(page: BrowserPageAutomation): Promise<string | null> {
    try {
      const snapshot = await page.snapshot({ maxChars: EXCERPT_CHARS });
      if (!snapshot.outline.trim()) return null;
      return `Snapshot excerpt (refs are valid until the page changes; call snapshot for the full page):\n${snapshot.outline}${snapshot.truncated ? '\n…' : ''}`;
    } catch {
      return null;
    }
  }

  private timeoutFor(name: string, args: Args): number {
    if (name !== 'wait_for') return this.timing.callTimeoutMs;
    const timeout =
      typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : DEFAULT_WAIT_SECONDS;
    const seconds = typeof args.seconds === 'number' ? args.seconds : 0;
    const longest = Math.min(Math.max(timeout, seconds), MAX_WAIT_SECONDS) * 1000;
    return Math.max(this.timing.callTimeoutMs, longest + WAIT_MARGIN_MS);
  }
}

function inScope(tab: AgentBrowserTab, scope: BrowserToolScope): boolean {
  return tab.projectId === scope.projectId && tab.taskId === scope.taskId;
}

function text(lines: string[]): AgentToolCallResult {
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function withExcerpt(lines: string[], excerpt: string | null): string[] {
  return excerpt ? [...lines, '', excerpt] : lines;
}

function forwardNote(target: ResolvedBrowserUrl): string | null {
  if (!target.forward) return null;
  return `localhost:${target.forward.remotePort} on the workspace host is forwarded over SSH to 127.0.0.1:${target.forward.localPort} for the in-app browser.`;
}

function titleOf(tab: { title: string }): string {
  return tab.title ? JSON.stringify(tab.title) : '(untitled)';
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function describeTarget(target: BrowserElementTarget): string {
  return 'ref' in target ? `[ref=${target.ref}]` : `(${target.x}, ${target.y})`;
}

function dialogNotice(dialog: BrowserDialog): string {
  return `A JavaScript ${dialog.type} dialog is now open (${JSON.stringify(dialog.message)}) and blocks the page; call handle_dialog to ${dialog.type === 'alert' ? 'dismiss it' : 'accept or dismiss it'}.`;
}

function formatHeaders(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers);
  if (entries.length === 0) return ['  (none)'];
  const lines = entries.slice(0, MAX_HEADER_LINES).map(([name, value]) => `  ${name}: ${value}`);
  if (entries.length > MAX_HEADER_LINES) {
    lines.push(`  … ${entries.length - MAX_HEADER_LINES} more`);
  }
  return lines;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatConsoleEntry(entry: BrowserConsoleEntry): string {
  const time = Number.isFinite(entry.time) ? new Date(entry.time).toISOString().slice(11, 23) : '';
  const message =
    entry.message.length > MAX_CONSOLE_MESSAGE_CHARS
      ? `${entry.message.slice(0, MAX_CONSOLE_MESSAGE_CHARS)}…`
      : entry.message;
  const source = entry.source
    ? ` (${entry.source}${entry.line !== undefined ? `:${entry.line}` : ''})`
    : '';
  return `[${entry.level}]${time ? ` ${time}` : ''} ${message}${source}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length > MAX_VALUE_CHARS
    ? `${serialized.slice(0, MAX_VALUE_CHARS)}\n[Truncated at ${MAX_VALUE_CHARS} characters.]`
    : serialized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserToolError(message)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ── Argüman okuma ─────────────────────────────────────────────────────────────

function optionalString(args: Args, key: string, maxLength: number): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BrowserToolError(`"${key}" must be a string.`);
  if (value.length > maxLength) {
    throw new BrowserToolError(`"${key}" is too long (at most ${maxLength} characters).`);
  }
  return value;
}

function requiredString(
  args: Args,
  key: string,
  maxLength: number,
  options: { allowEmpty?: boolean } = {}
): string {
  const value = optionalString(args, key, maxLength);
  if (value === undefined || (!options.allowEmpty && value.trim() === '')) {
    throw new BrowserToolError(`"${key}" is required.`);
  }
  return value;
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new BrowserToolError(`"${key}" must be true or false.`);
  return value;
}

function optionalNumber(
  args: Args,
  key: string,
  limits: { min: number; max: number; integer?: boolean }
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserToolError(`"${key}" must be a number.`);
  }
  if (value < limits.min || value > limits.max || (limits.integer && !Number.isInteger(value))) {
    throw new BrowserToolError(
      `"${key}" must be ${limits.integer ? 'an integer' : 'a number'} between ${limits.min} and ${limits.max}.`
    );
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  args: Args,
  key: string,
  values: T
): T[number] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new BrowserToolError(`"${key}" must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function optionalEnumArray<const T extends readonly string[]>(
  args: Args,
  key: string,
  values: T
): Array<T[number]> {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !values.includes(item))
  ) {
    throw new BrowserToolError(`"${key}" must be a list of: ${values.join(', ')}.`);
  }
  return value as Array<T[number]>;
}

function requiredStringArray(args: Args, key: string): string[] {
  const value = args[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.length > ID_LIMIT * 10)
  ) {
    throw new BrowserToolError(`"${key}" must be a non-empty list of strings.`);
  }
  return value as string[];
}

/** Snapshot referansı; ajan "[ref=e12]" ya da "ref=e12" yazsa da "e12" olarak alınır. */
function optionalRef(args: Args): string | undefined {
  const raw = optionalString(args, 'ref', ID_LIMIT);
  const ref = raw
    ?.trim()
    .replace(/^\[?\s*ref\s*=\s*/i, '')
    .replace(/\s*\]$/, '')
    .trim();
  return ref || undefined;
}

function elementTarget(args: Args, required: true): BrowserElementTarget;
function elementTarget(args: Args, required: boolean): BrowserElementTarget | null;
function elementTarget(args: Args, required: boolean): BrowserElementTarget | null {
  const ref = optionalRef(args);
  const x = optionalNumber(args, 'x', { min: 0, max: 100_000 });
  const y = optionalNumber(args, 'y', { min: 0, max: 100_000 });
  if (ref) {
    if (x !== undefined || y !== undefined) {
      throw new BrowserToolError('Pass either ref or x and y, not both.');
    }
    return { ref };
  }
  if (x !== undefined || y !== undefined) {
    if (x === undefined || y === undefined) throw new BrowserToolError('Pass both x and y.');
    return { x, y };
  }
  if (required) {
    throw new BrowserToolError('Pass ref (from snapshot) or x and y viewport coordinates.');
  }
  return null;
}
