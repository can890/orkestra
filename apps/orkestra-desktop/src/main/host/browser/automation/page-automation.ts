import type { WebContents } from 'electron';
import type {
  BrowserConsoleEntry,
  BrowserElementTarget,
  BrowserKeyModifier,
  BrowserPageAutomation,
  BrowserPageInfo,
  BrowserScreenshot,
  BrowserSnapshot,
} from '@core/primitives/browser/api/agent-browser';
import { CdpSession } from './cdp-session';
import {
  ConsoleBuffer,
  consoleEntryFromDetails,
  type ConsoleMessageDetails,
} from './console-buffer';
import { captureEmbedderFocus, restoreEmbedderFocus } from './embedder-focus';
import { decodeEvaluationResult, prepareEvaluation } from './evaluate-script';
import {
  isClipboardPasteChord,
  isSelectAllChord,
  keyEventSequence,
  parseKeyCombo,
  selectAllChord,
  type ParsedKey,
} from './keyboard';
import {
  ERR_ABORTED,
  resolveNavigationUrl,
  watchNavigation,
  type NavigationOutcome,
} from './navigation';
import { OperationQueue } from './operation-queue';
import {
  buildPageScript,
  type EditState,
  type PageCommand,
  type PageCommandKind,
  type PageCommandOf,
  type PageOutput,
  type PageResult,
  type PageTarget,
  type ScrollDirection,
  type ScrollPosition,
} from './page-script';
import {
  cssToWidgetPoint,
  mouseClickEvents,
  mouseMoveEvent,
  mouseWheelEvent,
  type MouseButton,
  type Point,
} from './pointer';
import { captureScreenshot } from './screenshot';
import { runAsAutomationInput } from './synthetic-input';
import { clampNumber, delay, TimeoutError, withTimeout } from './timing';

/**
 * Ajan betiğinin izole dünya kimliği. Electron'un kendi dünyası (999) ve eklenti aralığı
 * (1 << 20 ve üstü) ile çakışmaz; durum bu dünyada belge ömrü boyunca kalır.
 */
export const PAGE_AGENT_WORLD_ID = 31_337;

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_NAVIGATION_TIMEOUT_MS = 120_000;
const NAVIGATION_IDLE_MS = 1_500;
const PAGE_CALL_TIMEOUT_MS = 15_000;
const METRICS_TIMEOUT_MS = 5_000;
const EVALUATE_TIMEOUT_MS = 30_000;
const CDP_TIMEOUT_MS = 2_000;
const EMBEDDER_CAPTURE_TIMEOUT_MS = 1_000;
const EMBEDDER_RESTORE_TIMEOUT_MS = 2_000;
const POST_ACTION_IDLE_MS = 200;
const POST_ACTION_TIMEOUT_MS = 10_000;
const INPUT_GRACE_MS = 300;
const CONTEXT_MENU_GRACE_MS = 1_000;
const HOVER_SETTLE_MS = 100;
const KEY_SETTLE_MS = 30;
const EDIT_POLL_MS = 30;
const EDIT_POLL_ATTEMPTS = 6;
const SCROLL_POLL_MS = 25;
const SCROLL_SETTLE_TIMEOUT_MS = 250;
const WAIT_FOR_POLL_MS = 200;
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 10_000;
const WAIT_FOR_MAX_TIMEOUT_MS = 120_000;
const WAIT_TIME_MAX_MS = 30_000;
const SNAPSHOT_DEFAULT_MAX_CHARS = 12_000;
const TEXT_DEFAULT_MAX_CHARS = 20_000;

const TAB_CLOSED = 'The browser tab has been closed.';
const AUTOMATION_DISPOSED =
  'Page automation for this tab has been disposed; get a new page handle.';
const ENTER_KEY: ParsedKey = { keyCode: 'Enter', text: '\r', modifiers: [] };
const BACKSPACE_KEY: ParsedKey = { keyCode: 'Backspace', text: null, modifiers: [] };
const MOUSE_BUTTONS: readonly MouseButton[] = ['left', 'right', 'middle'];
const KEY_MODIFIERS: readonly BrowserKeyModifier[] = ['shift', 'control', 'alt', 'meta'];
const SCROLL_DIRECTIONS: readonly ScrollDirection[] = ['up', 'down', 'left', 'right'];

export type PageAutomationOptions = {
  /**
   * Güvenilir tıklama `<webview>`'e taşıdığı gömücü (embedder) odağını geri versin mi
   * (varsayılan true). Ayrıntı: embedder-focus.ts.
   */
  preserveEmbedderFocus?: boolean;
  /** Klavye kısayolları için platform; varsayılan process.platform (testler için). */
  platform?: NodeJS.Platform;
};

/**
 * Bir sekmenin WebContents'i için sayfa kontrolcüsü. Çağıran WebContents başına tek örnek
 * tutar ve işi bitince `dispose()` çağırır; WebContents yok edildiğinde de kendiliğinden
 * temizlenir. İşlemler sayfa başına sırayla çalışır.
 */
export function createPageAutomation(
  webContents: WebContents,
  options: PageAutomationOptions = {}
): BrowserPageAutomation {
  return new PageAutomation(webContents, options);
}

type AnyInputEvent =
  | Electron.MouseInputEvent
  | Electron.MouseWheelInputEvent
  | Electron.KeyboardInputEvent;

type ClickOptions = { button: MouseButton; clickCount: number; modifiers: BrowserKeyModifier[] };

class PageAutomation implements BrowserPageAutomation {
  private readonly queue = new OperationQueue();
  private readonly consoleBuffer = new ConsoleBuffer();
  private readonly cdp: CdpSession;
  private readonly cleanups: Array<() => void> = [];
  private readonly platform: NodeJS.Platform;
  private readonly preserveEmbedderFocus: boolean;
  private disposed = false;
  private refsValid = false;
  private refGeneration = 0;
  private refStart = 1;
  private lastUrl: string;
  private crashReason: string | null = null;
  private focusEmulationOn = false;

  constructor(
    private readonly webContents: WebContents,
    options: PageAutomationOptions
  ) {
    this.platform = options.platform ?? process.platform;
    this.preserveEmbedderFocus = options.preserveEmbedderFocus ?? true;
    this.cdp = new CdpSession(webContents);
    this.lastUrl = webContents.getURL();
    this.listen();
  }

  // -----------------------------------------------------------------------------------------
  // Gezinme
  // -----------------------------------------------------------------------------------------

  navigate(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageInfo> {
    return this.run(
      async () => {
        const target = resolveNavigationUrl(url);
        const timeoutMs = clampNumber(
          options?.timeoutMs,
          DEFAULT_NAVIGATION_TIMEOUT_MS,
          1_000,
          MAX_NAVIGATION_TIMEOUT_MS
        );
        this.invalidateRefs();
        const watch = watchNavigation(this.webContents, { timeoutMs });
        const load = this.webContents.loadURL(target).then(
          () => null,
          (error: unknown) => error
        );
        watch.armIdle(NAVIGATION_IDLE_MS);
        const outcome = await watch.outcome;
        const loadError = await Promise.race([load, delay(100).then(() => null)]);
        return this.finishNavigation(outcome, target, timeoutMs, loadError);
      },
      { allowCrashed: true }
    );
  }

  goBack(): Promise<BrowserPageInfo> {
    return this.run(async () => {
      const history = this.webContents.navigationHistory;
      if (!history.canGoBack()) {
        throw new Error('Cannot go back: there is no previous page in this tab.');
      }
      return this.historyNavigation(() => history.goBack(), 'the previous page');
    });
  }

  goForward(): Promise<BrowserPageInfo> {
    return this.run(async () => {
      const history = this.webContents.navigationHistory;
      if (!history.canGoForward()) {
        throw new Error('Cannot go forward: there is no next page in this tab.');
      }
      return this.historyNavigation(() => history.goForward(), 'the next page');
    });
  }

  reload(): Promise<BrowserPageInfo> {
    return this.run(
      async () =>
        this.historyNavigation(
          () => this.webContents.reload(),
          this.webContents.getURL() || 'the page'
        ),
      { allowCrashed: true }
    );
  }

  // -----------------------------------------------------------------------------------------
  // Okuma
  // -----------------------------------------------------------------------------------------

  snapshot(options?: { maxChars?: number }): Promise<BrowserSnapshot> {
    return this.run(async () => {
      const maxChars = Math.floor(
        clampNumber(options?.maxChars, SNAPSHOT_DEFAULT_MAX_CHARS, 500, 200_000)
      );
      const generation = this.refGeneration;
      const result = await this.page({
        kind: 'snapshot',
        maxChars,
        resetRefs: !this.refsValid,
        refStart: this.refStart,
      });
      this.refStart = Math.max(this.refStart, result.nextRef);
      if (generation === this.refGeneration) this.refsValid = true;
      return {
        url: result.url,
        title: result.title,
        outline: result.outline,
        truncated: result.truncated,
      };
    });
  }

  getText(options?: { maxChars?: number }): Promise<{ text: string; truncated: boolean }> {
    return this.run(async () => {
      const maxChars = Math.floor(
        clampNumber(options?.maxChars, TEXT_DEFAULT_MAX_CHARS, 100, 1_000_000)
      );
      return this.page({ kind: 'text', maxChars });
    });
  }

  screenshot(options?: { fullPage?: boolean }): Promise<BrowserScreenshot> {
    return this.run(async () => {
      const metrics = await this.page({ kind: 'metrics' }, METRICS_TIMEOUT_MS).catch(() => null);
      return captureScreenshot({
        webContents: this.webContents,
        cdp: this.cdp,
        fullPage: options?.fullPage === true,
        metrics,
      });
    });
  }

  evaluate(expression: string): Promise<unknown> {
    return this.run(async () => {
      if (typeof expression !== 'string' || expression.trim().length === 0) {
        throw new Error('Pass a JavaScript expression to evaluate.');
      }
      const prepared = prepareEvaluation(expression);
      const deadline = Date.now() + EVALUATE_TIMEOUT_MS;
      await this.waitUntilScriptable(deadline);
      const startedAt = Date.now();
      let raw: unknown;
      try {
        raw = await withTimeout(
          this.webContents.executeJavaScript(prepared.source, false),
          Math.max(1, deadline - Date.now()),
          () =>
            new TimeoutError(
              `Evaluation timed out after ${EVALUATE_TIMEOUT_MS / 1000} s; the expression may be ` +
                'waiting on a promise that never settles.'
            )
        );
      } catch (error) {
        if (error instanceof TimeoutError) throw error;
        this.guard();
        const consoleError = this.consoleBuffer.latestErrorSince(startedAt);
        const detail =
          consoleError?.message ?? (error instanceof Error ? error.message : String(error));
        throw new Error(`Evaluation failed: ${detail}`);
      }
      return decodeEvaluationResult(raw);
    });
  }

  consoleMessages(options?: {
    sinceMs?: number;
    limit?: number;
    clear?: boolean;
  }): BrowserConsoleEntry[] {
    if (this.disposed) {
      throw new Error(this.webContents.isDestroyed() ? TAB_CLOSED : AUTOMATION_DISPOSED);
    }
    return this.consoleBuffer.read(options ?? {});
  }

  waitFor(options: {
    text?: string;
    textGone?: string;
    timeMs?: number;
    timeoutMs?: number;
  }): Promise<{ satisfied: boolean }> {
    return this.run(async () => {
      const text = nonEmptyString(options?.text);
      const textGone = nonEmptyString(options?.textGone);
      const timeMs = options?.timeMs;
      const hasTime = typeof timeMs === 'number' && Number.isFinite(timeMs);
      if (text === null && textGone === null && !hasTime) {
        throw new Error('waitFor needs text, textGone or timeMs.');
      }
      if (hasTime) {
        await delay(clampNumber(timeMs, 0, 0, WAIT_TIME_MAX_MS));
        this.guard();
      }
      if (text === null && textGone === null) return { satisfied: true };
      const timeoutMs = clampNumber(
        options?.timeoutMs,
        WAIT_FOR_DEFAULT_TIMEOUT_MS,
        0,
        WAIT_FOR_MAX_TIMEOUT_MS
      );
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        this.guard();
        try {
          const result = await this.page(
            { kind: 'matchText', text, textGone },
            Math.max(1_000, deadline - Date.now())
          );
          if (result.textFound && result.textGoneAbsent) return { satisfied: true };
        } catch {
          // Gezinme ya da geçici yanıtsızlık: süre dolana kadar denemeye devam.
          this.guard();
        }
        if (Date.now() + WAIT_FOR_POLL_MS >= deadline) return { satisfied: false };
        await delay(WAIT_FOR_POLL_MS);
      }
    });
  }

  // -----------------------------------------------------------------------------------------
  // Etkileşim
  // -----------------------------------------------------------------------------------------

  click(
    target: BrowserElementTarget,
    options?: {
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      modifiers?: BrowserKeyModifier[];
    }
  ): Promise<void> {
    return this.run(async () => {
      const pageTarget = this.toPageTarget(target);
      const clickOptions: ClickOptions = {
        button: parseButton(options?.button),
        clickCount: Math.floor(clampNumber(options?.clickCount, 1, 1, 3)),
        modifiers: parseModifiers(options?.modifiers),
      };
      await this.prepareInteraction();
      const located = await this.page({
        kind: 'locate',
        target: pageTarget,
        purpose: 'click',
        scroll: true,
      });
      await this.clickAt(located.point, clickOptions);
    });
  }

  hover(target: BrowserElementTarget): Promise<void> {
    return this.run(async () => {
      const pageTarget = this.toPageTarget(target);
      const located = await this.page({
        kind: 'locate',
        target: pageTarget,
        purpose: 'hover',
        scroll: true,
      });
      this.send([mouseMoveEvent(this.toWidget(located.point))], INPUT_GRACE_MS);
      await delay(HOVER_SETTLE_MS);
    });
  }

  type(
    target: BrowserElementTarget | null,
    text: string,
    options?: { clear?: boolean; submit?: boolean }
  ): Promise<void> {
    return this.run(async () => {
      if (typeof text !== 'string') throw new Error('Pass the text to type as a string.');
      const clear = options?.clear === true;
      const submit = options?.submit === true;
      await this.prepareInteraction();
      if (target !== null && target !== undefined) {
        const pageTarget = this.toPageTarget(target);
        const prepared = await this.page({ kind: 'prepareType', target: pageTarget });
        if (prepared.mode === 'value') {
          await this.page({ kind: 'setValue', target: pageTarget, value: text });
          if (submit) await this.pressParsed(ENTER_KEY);
          return;
        }
        if (!prepared.focused) {
          if (prepared.point) {
            await this.clickAt(prepared.point, { button: 'left', clickCount: 1, modifiers: [] });
          }
          const focus = await this.page({ kind: 'focus', target: pageTarget });
          if (!focus.focused) {
            throw new Error(
              `Could not focus ${prepared.label}${prepared.occlusion ? `: ${prepared.occlusion}` : '.'}`
            );
          }
        }
        if (!clear) await this.page({ kind: 'caretToEnd' });
      }
      const state = await this.page({ kind: 'editState' });
      if (state.kind === 'none') {
        throw new Error('No element is focused; pass the ref of a textbox to type into.');
      }
      if (state.kind === 'other') {
        throw new Error(
          `The focused element ${state.label} is not editable; pass the ref of a textbox.`
        );
      }
      if (clear) await this.clearFocused(state);
      if (text.length > 0) await this.webContents.insertText(text);
      if (submit) await this.pressParsed(ENTER_KEY);
    });
  }

  pressKey(key: string): Promise<void> {
    return this.run(async () => {
      const parsed = parseKeyCombo(key, this.platform);
      if (isClipboardPasteChord(parsed)) {
        throw new Error(
          'Pasting from the system clipboard is not allowed; use type to enter text.'
        );
      }
      await this.prepareInteraction();
      await this.pressParsed(parsed);
    });
  }

  scroll(options: {
    target?: BrowserElementTarget;
    direction?: 'up' | 'down' | 'left' | 'right';
    amount?: number;
  }): Promise<void> {
    return this.run(async () => {
      const direction = parseDirection(options?.direction);
      const pageTarget = options?.target ? this.toPageTarget(options.target) : null;
      const requested = options?.amount;
      if (
        requested !== undefined &&
        (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0)
      ) {
        throw new Error('Scroll amount must be a positive number of CSS pixels.');
      }
      const probe = await this.page({ kind: 'scrollProbe', target: pageTarget, direction });
      const amount = requested ?? probe.defaultAmount;
      const zoom = this.zoomFactor();
      this.send(
        [mouseWheelEvent(cssToWidgetPoint(probe.point, zoom), direction, amount * zoom)],
        INPUT_GRACE_MS
      );
      const after = await this.waitForScroll(probe.position);
      // Gizli sekmede tekerlek olayı hiç kaydırmaz (Electron 40'ta doğrulandı); eksik kalan
      // miktarı kaydırıcıda betikle tamamlarız (kaydırıcının sonundaysa bu işlem etkisizdir).
      const remaining = amount - scrolledAlong(probe.position, after, direction);
      if (remaining >= 1) await this.page({ kind: 'scrollBy', direction, amount: remaining });
    });
  }

  selectOption(target: BrowserElementTarget, values: string[]): Promise<string[]> {
    return this.run(async () => {
      const pageTarget = this.toPageTarget(target);
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        throw new Error('Pass the option values or labels as an array of strings.');
      }
      const result = await this.page({ kind: 'selectOption', target: pageTarget, values });
      return result.selected;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Yok edilmiş WebContents'ten dinleyici kaldırmak başarısız olabilir.
      }
    }
    this.cdp.dispose();
  }

  // -----------------------------------------------------------------------------------------
  // Yardımcılar
  // -----------------------------------------------------------------------------------------

  private listen(): void {
    const wc = this.webContents;
    const onConsole = (details: ConsoleMessageDetails) => {
      const entry = consoleEntryFromDetails(details, Date.now());
      if (entry) this.consoleBuffer.push(entry);
    };
    const onNavigate = (_event: unknown, url: string) => {
      this.invalidateRefs();
      this.lastUrl = url;
      this.crashReason = null;
    };
    const onNavigateInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      // Yalnızca durum değiştiren (aynı URL'li) replaceState referansları geçersiz kılmaz.
      if (url !== this.lastUrl) this.invalidateRefs();
      this.lastUrl = url;
    };
    const onGone = (_event: unknown, details: { reason?: string }) => {
      this.crashReason = details?.reason ?? 'unknown';
      this.invalidateRefs();
      this.focusEmulationOn = false;
      this.cdp.resetEmulationState();
    };
    const onDestroyed = () => this.dispose();
    wc.on('console-message', onConsole);
    wc.on('did-navigate', onNavigate);
    wc.on('did-navigate-in-page', onNavigateInPage);
    wc.on('render-process-gone', onGone);
    wc.on('destroyed', onDestroyed);
    this.cleanups.push(() => {
      wc.removeListener('console-message', onConsole);
      wc.removeListener('did-navigate', onNavigate);
      wc.removeListener('did-navigate-in-page', onNavigateInPage);
      wc.removeListener('render-process-gone', onGone);
      wc.removeListener('destroyed', onDestroyed);
    });
  }

  private run<T>(task: () => Promise<T>, guardOptions?: { allowCrashed?: boolean }): Promise<T> {
    return this.queue.run(async () => {
      this.guard(guardOptions);
      return task();
    });
  }

  private guard(options: { allowCrashed?: boolean } = {}): void {
    if (this.webContents.isDestroyed()) throw new Error(TAB_CLOSED);
    if (this.disposed) throw new Error(AUTOMATION_DISPOSED);
    if (!options.allowCrashed && (this.crashReason !== null || this.webContents.isCrashed())) {
      const reason = this.crashReason ? ` (${this.crashReason})` : '';
      throw new Error(`The page has crashed${reason}; call reload or navigate to recover.`);
    }
  }

  private invalidateRefs(): void {
    this.refsValid = false;
    this.refGeneration += 1;
  }

  private pageInfo(): BrowserPageInfo {
    return { url: this.webContents.getURL(), title: this.webContents.getTitle() };
  }

  private zoomFactor(): number {
    const zoom = this.webContents.getZoomFactor();
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }

  private toWidget(point: Point): Point {
    return cssToWidgetPoint(point, this.zoomFactor());
  }

  private toPageTarget(target: BrowserElementTarget): PageTarget {
    if (target && typeof target === 'object') {
      if ('ref' in target && typeof target.ref === 'string') {
        const ref = target.ref.trim();
        if (!this.refsValid) {
          throw new Error(`Element ref ${ref || '(empty)'} not found; take a new snapshot.`);
        }
        return { ref };
      }
      if ('x' in target && typeof target.x === 'number' && typeof target.y === 'number') {
        return { x: target.x, y: target.y };
      }
    }
    throw new Error(
      'Invalid target; pass { ref } from the latest snapshot or { x, y } in CSS pixels.'
    );
  }

  /** Sayfa yüklenirken Electron betik çalıştırmayı bekletir; bunu süre sınırıyla kendimiz yaparız. */
  private async waitUntilScriptable(deadline: number): Promise<void> {
    const wc = this.webContents;
    const scriptable = () => wc.isDestroyed() || (wc.getURL() !== '' && !wc.isLoadingMainFrame());
    if (scriptable()) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        wc.removeListener('did-stop-loading', done);
        wc.removeListener('destroyed', done);
        resolve();
      };
      timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      wc.on('did-stop-loading', done);
      wc.on('destroyed', done);
    });
    this.guard();
    if (!scriptable()) {
      throw new TimeoutError(
        'The page is still loading and did not respond in time; try again later or use waitFor.'
      );
    }
  }

  private async page<K extends PageCommandKind>(
    command: PageCommandOf<K>,
    timeoutMs: number = PAGE_CALL_TIMEOUT_MS
  ): Promise<PageOutput<K>> {
    const deadline = Date.now() + timeoutMs;
    await this.waitUntilScriptable(deadline);
    let raw: unknown;
    try {
      raw = await withTimeout(
        this.webContents.executeJavaScriptInIsolatedWorld(
          PAGE_AGENT_WORLD_ID,
          // Genel K için PageCommandOf<K> birleşime atanabilir; derleyici bunu kanıtlayamıyor.
          [{ code: buildPageScript(command as PageCommand) }],
          false
        ),
        Math.max(1, deadline - Date.now()),
        () =>
          new TimeoutError(
            `The page did not respond within ${Math.round(timeoutMs / 1000)} s (it may be busy, ` +
              'still loading, or blocked by a JavaScript dialog).'
          )
      );
    } catch (error) {
      if (error instanceof TimeoutError) throw error;
      this.guard();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`The page script could not run: ${message}`);
    }
    if (!isPageResult(raw)) throw new Error('The page script returned an unexpected result.');
    if (!raw.ok) throw new Error(raw.error);
    // Değer, komut türüne karşılık gelen çıktıyı üreten kendi betiğimizden gelir.
    return raw.value as PageOutput<K>;
  }

  private finishNavigation(
    outcome: NavigationOutcome,
    label: string,
    timeoutMs: number,
    loadError: unknown = null
  ): BrowserPageInfo {
    switch (outcome.kind) {
      case 'settled': {
        const failure = describeLoadFailure(loadError);
        if (failure) throw new Error(`Navigation to ${label} failed: ${failure}.`);
        return this.pageInfo();
      }
      case 'failed':
        throw new Error(
          `Navigation to ${outcome.url || label} failed: ${outcome.errorDescription || 'error'} ` +
            `(${outcome.errorCode}).`
        );
      case 'timeout':
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for ${label} to load. The page may still be ` +
            'loading; take a snapshot to inspect its current state.'
        );
      case 'destroyed':
        throw new Error('The browser tab was closed during navigation.');
      case 'crashed':
        throw new Error(`The page crashed during navigation (${outcome.reason}).`);
    }
  }

  private async historyNavigation(trigger: () => void, label: string): Promise<BrowserPageInfo> {
    this.invalidateRefs();
    const watch = watchNavigation(this.webContents, { timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS });
    trigger();
    watch.armIdle(NAVIGATION_IDLE_MS);
    return this.finishNavigation(await watch.outcome, label, DEFAULT_NAVIGATION_TIMEOUT_MS);
  }

  /** Odak öykünmesini açar (en iyi çaba); arka plandaki sayfada odak olayları çalışır. */
  private async prepareInteraction(): Promise<void> {
    this.focusEmulationOn = await this.cdp.enableFocusEmulation(CDP_TIMEOUT_MS);
  }

  private send(events: AnyInputEvent[], graceMs: number): void {
    this.guard();
    runAsAutomationInput(
      this.webContents,
      () => {
        for (const event of events) this.webContents.sendInputEvent(event);
      },
      graceMs
    );
  }

  private async clickAt(point: Point, options: ClickOptions): Promise<void> {
    const events = mouseClickEvents(this.toWidget(point), options);
    await this.settleAfter(() =>
      this.withEmbedderFocus(async () => {
        this.send(events, options.button === 'right' ? CONTEXT_MENU_GRACE_MS : INPUT_GRACE_MS);
      })
    );
  }

  private async withEmbedderFocus(action: () => Promise<void>): Promise<void> {
    // Odak öykünmesi yoksa geri alım sayfaya blur gönderir (açık menüler kapanır); dokunma.
    if (!this.preserveEmbedderFocus || !this.focusEmulationOn) {
      await action();
      return;
    }
    const memo = await withTimeout(
      captureEmbedderFocus(this.webContents),
      EMBEDDER_CAPTURE_TIMEOUT_MS
    ).catch(() => null);
    try {
      await action();
    } finally {
      if (memo) {
        await withTimeout(restoreEmbedderFocus(memo), EMBEDDER_RESTORE_TIMEOUT_MS).catch(
          () => undefined
        );
      }
    }
  }

  /**
   * Girdinin tetiklediği gezinmenin oturmasını bekler (bağlantı tıklaması, Enter ile form
   * gönderimi). Gezinme başlamazsa kısa bir boşta kalma süresi sonunda döner; gezinme hatası
   * girdi işlemini başarısız saymaz.
   */
  private async settleAfter(action: () => Promise<void>): Promise<void> {
    const watch = watchNavigation(this.webContents, { timeoutMs: POST_ACTION_TIMEOUT_MS });
    try {
      await action();
    } catch (error) {
      watch.dispose();
      throw error;
    }
    watch.armIdle(POST_ACTION_IDLE_MS);
    await watch.outcome;
  }

  private async pressParsed(parsed: ParsedKey): Promise<void> {
    // macOS'ta sentetik Meta+A metni seçmez (menü kısayolu olarak işlenir; doğrulandı).
    // Sayfa olayı engellemediyse yerel "tümünü seç" düzenleme komutunu çalıştırırız.
    const emulateSelectAll = this.platform === 'darwin' && isSelectAllChord(parsed, this.platform);
    if (emulateSelectAll) await this.page({ kind: 'watchKey' }).catch(() => null);
    await this.settleAfter(async () => {
      this.send(keyEventSequence(parsed), INPUT_GRACE_MS);
    });
    if (emulateSelectAll) {
      const result = await this.page({ kind: 'keyResult' }).catch(() => null);
      if (!result?.defaultPrevented) this.webContents.selectAll();
    }
  }

  private async clearFocused(initial: EditState): Promise<void> {
    if (initial.empty) return;
    this.send(keyEventSequence(selectAllChord(this.platform)), INPUT_GRACE_MS);
    await delay(KEY_SETTLE_MS);
    let state = await this.page({ kind: 'editState' });
    if (!state.allSelected && !state.empty) {
      // Sentetik Meta+A macOS'ta seçmez; yerel düzenleme komutu her platformda çalışır.
      this.webContents.selectAll();
      await delay(KEY_SETTLE_MS);
    }
    if (!state.empty) {
      this.send(keyEventSequence(BACKSPACE_KEY), INPUT_GRACE_MS);
      state = await this.pollEditState((current) => current.empty);
    }
    if (!state.empty) {
      const forced = await this.page({ kind: 'forceClear' });
      if (!forced.empty) throw new Error(`Could not clear ${state.label}.`);
    }
  }

  private async pollEditState(done: (state: EditState) => boolean): Promise<EditState> {
    let state = await this.page({ kind: 'editState' });
    for (let attempt = 1; attempt < EDIT_POLL_ATTEMPTS && !done(state); attempt++) {
      await delay(EDIT_POLL_MS);
      state = await this.page({ kind: 'editState' });
    }
    return state;
  }

  /** Kesin tekerlek deltaları hemen uygulanır; konum değişince ya da süre dolunca döner. */
  private async waitForScroll(before: ScrollPosition): Promise<ScrollPosition> {
    const deadline = Date.now() + SCROLL_SETTLE_TIMEOUT_MS;
    let position = before;
    while (Date.now() < deadline) {
      await delay(SCROLL_POLL_MS);
      position = (await this.page({ kind: 'scrollRead' })).position;
      if (!samePosition(position, before)) return position;
    }
    return position;
  }
}

function isPageResult(value: unknown): value is PageResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as { ok?: unknown; error?: unknown };
  if (record.ok === true) return 'value' in record;
  return record.ok === false && typeof record.error === 'string';
}

function describeLoadFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const details = error as Error & { errno?: unknown; code?: unknown };
  if (typeof details.errno !== 'number' || details.errno === ERR_ABORTED) return null;
  const code = typeof details.code === 'string' && details.code ? details.code : 'ERR_FAILED';
  const hint =
    details.errno === -2 ? ' (the URL may have started a download or returned no content)' : '';
  return `${code} (${details.errno})${hint}`;
}

/** Hedef kaydırıcının istenen yönde kaydığı miktar (CSS piksel). */
function scrolledAlong(
  before: ScrollPosition,
  after: ScrollPosition,
  direction: ScrollDirection
): number {
  switch (direction) {
    case 'down':
      return Math.max(0, after.y - before.y);
    case 'up':
      return Math.max(0, before.y - after.y);
    case 'right':
      return Math.max(0, after.x - before.x);
    case 'left':
      return Math.max(0, before.x - after.x);
  }
}

function samePosition(a: ScrollPosition, b: ScrollPosition): boolean {
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.windowX - b.windowX) < 1 &&
    Math.abs(a.windowY - b.windowY) < 1
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseButton(value: unknown): MouseButton {
  if (value === undefined) return 'left';
  const button = MOUSE_BUTTONS.find((candidate) => candidate === value);
  if (!button) throw new Error('Invalid mouse button; use "left", "right" or "middle".');
  return button;
}

function parseModifiers(value: unknown): BrowserKeyModifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error('Modifiers must be an array of shift, control, alt or meta.');
  const result: BrowserKeyModifier[] = [];
  for (const item of value) {
    const modifier = KEY_MODIFIERS.find((candidate) => candidate === item);
    if (!modifier)
      throw new Error(`Invalid modifier ${JSON.stringify(item)}; use shift, control, alt or meta.`);
    if (!result.includes(modifier)) result.push(modifier);
  }
  return result;
}

function parseDirection(value: unknown): ScrollDirection {
  if (value === undefined) return 'down';
  const direction = SCROLL_DIRECTIONS.find((candidate) => candidate === value);
  if (!direction) throw new Error('Invalid scroll direction; use up, down, left or right.');
  return direction;
}
