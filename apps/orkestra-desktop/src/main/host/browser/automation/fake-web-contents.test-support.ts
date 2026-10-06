import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { WebContents } from 'electron';
import { PAGE_AGENT_VERSION, pageAgent, type PageCommand, type PageResult } from './page-script';
import { pageRecorder } from './recorder-script';
import { isAutomationInputActive } from './synthetic-input';

/**
 * Yalnızca birim testleri için sahte WebContents: olay yayıcı, kaydedilen giriş olayları,
 * izole dünya komutlarının çözülüp test işleyicisine verilmesi ve ana dünya betiklerinin
 * Node `vm` ile gerçekten çalıştırılması.
 */

type AnyInputEvent =
  | Electron.MouseInputEvent
  | Electron.MouseWheelInputEvent
  | Electron.KeyboardInputEvent;

const RECORDER_SCRIPT_PREFIX = `(${pageRecorder.toString()})(window, `;

/** Kayıt betiği çağrısının nonce ve kipini çözer. */
export function decodeRecorderScript(code: string): { nonce: string; mode: string } | null {
  if (!code.startsWith(RECORDER_SCRIPT_PREFIX)) return null;
  const nonce = /^"([0-9a-f]+)"/.exec(code.slice(RECORDER_SCRIPT_PREFIX.length))?.[1] ?? '';
  const mode = code.endsWith('"stop")') ? 'stop' : code.endsWith('"start")') ? 'start' : '';
  return { nonce, mode };
}

const PAGE_SCRIPT_PREFIX = `(${pageAgent.toString()})(window, ${JSON.stringify(PAGE_AGENT_VERSION)}, `;

export function decodePageCommand(code: string): PageCommand {
  if (!code.startsWith(PAGE_SCRIPT_PREFIX) || !code.endsWith(')')) {
    throw new Error('Unexpected isolated world script');
  }
  return JSON.parse(code.slice(PAGE_SCRIPT_PREFIX.length, -1)) as PageCommand;
}

export class FakeDebugger extends EventEmitter {
  attached = false;
  readonly commands: Array<{ method: string; params: unknown }> = [];
  respond: (method: string, params: unknown) => Promise<unknown> = async () => ({});

  attach(): void {
    if (this.attached) throw new Error('Another debugger is already attached');
    this.attached = true;
  }

  isAttached(): boolean {
    return this.attached;
  }

  detach(): void {
    this.attached = false;
  }

  sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push({ method, params });
    return this.respond(method, params);
  }
}

export type FakeHost = {
  isDestroyed(): boolean;
  scripts: string[];
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    sources: Array<{ code: string }>
  ): Promise<unknown>;
};

export function createFakeHost(): FakeHost {
  const host: FakeHost = {
    scripts: [],
    isDestroyed: () => false,
    async executeJavaScriptInIsolatedWorld(_worldId, sources) {
      const code = sources[0]?.code ?? '';
      host.scripts.push(code);
      return code.includes('const memo') ? 'restored' : true;
    },
  };
  return host;
}

export class FakeWebContents extends EventEmitter {
  id = 1;
  url = 'https://start.test/';
  title = 'Start';
  destroyed = false;
  crashed = false;
  loadingMainFrame = false;
  zoom = 1;
  canGoBack = false;
  canGoForward = false;
  hostWebContents: FakeHost | null = null;
  readonly debugger = new FakeDebugger();
  readonly inputEvents: AnyInputEvent[] = [];
  /** Her giriş olayı gönderilirken ajan girişi işaretinin açık olup olmadığı. */
  readonly inputMarkedAsAutomation: boolean[] = [];
  readonly insertedText: string[] = [];
  readonly loadedUrls: string[] = [];
  readonly pageCommands: PageCommand[] = [];
  readonly recorderCalls: Array<{ nonce: string; mode: string }> = [];
  /** Kayıt betiğinin 'stop' kipinde döndürdüğü mesajlar. */
  recorderStopResult: string[] = [];
  selectAllCalls = 0;
  backgroundThrottling = true;
  reloadCalls = 0;
  pageHandler: (command: PageCommand) => PageResult | Promise<PageResult> = () => ({
    ok: false,
    error: 'no page handler',
  });
  onLoadURL: (url: string) => Promise<void> = async () => undefined;
  capturePageImpl: () => Promise<unknown> = () => new Promise(() => undefined);
  readonly navigationHistory = {
    canGoBack: () => this.canGoBack,
    canGoForward: () => this.canGoForward,
    goBack: () => this.emitMainFrameNavigation('https://start.test/back'),
    goForward: () => this.emitMainFrameNavigation('https://start.test/forward'),
  };

  asWebContents(): WebContents {
    return this as unknown as WebContents;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isCrashed(): boolean {
    return this.crashed;
  }

  isLoadingMainFrame(): boolean {
    return this.loadingMainFrame;
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  getZoomFactor(): number {
    return this.zoom;
  }

  sendInputEvent(event: AnyInputEvent): void {
    if (this.destroyed) throw new Error('Object has been destroyed');
    this.inputEvents.push(event);
    this.inputMarkedAsAutomation.push(isAutomationInputActive(this.asWebContents()));
  }

  async insertText(text: string): Promise<void> {
    this.insertedText.push(text);
  }

  getBackgroundThrottling(): boolean {
    return this.backgroundThrottling;
  }

  setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottling = allowed;
  }

  selectAll(): void {
    this.selectAllCalls += 1;
  }

  reload(): void {
    this.reloadCalls += 1;
    this.crashed = false;
    this.emitMainFrameNavigation(this.url);
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    return this.onLoadURL(url);
  }

  capturePage(): Promise<unknown> {
    return this.capturePageImpl();
  }

  async executeJavaScriptInIsolatedWorld(
    _worldId: number,
    sources: Array<{ code: string }>
  ): Promise<unknown> {
    const code = sources[0]?.code ?? '';
    const recorder = decodeRecorderScript(code);
    if (recorder) {
      this.recorderCalls.push(recorder);
      return recorder.mode === 'stop' ? this.recorderStopResult : [];
    }
    const command = decodePageCommand(code);
    this.pageCommands.push(command);
    return this.pageHandler(command);
  }

  /** Ana dünya betiğini (evaluate sarmalayıcısı) yalıtılmış bir vm bağlamında çalıştırır. */
  async executeJavaScript(code: string): Promise<unknown> {
    return runInNewContext(code, { setTimeout });
  }

  /** Tam bir ana çerçeve gezinmesini olaylarla taklit eder. */
  emitMainFrameNavigation(url: string): void {
    this.emit('did-start-loading');
    this.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: false, url },
      url,
      false,
      true
    );
    this.url = url;
    this.emit('did-navigate', {}, url, 200, 'OK');
    this.emit('did-finish-load');
    this.emit('did-stop-loading');
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

export function pageOk(value: unknown): PageResult {
  return { ok: true, value };
}
