import { action, makeObservable, observable } from 'mobx';

/** Görünüm alanına (viewport) göre CSS piksel cinsinden dikdörtgen. */
export type BrowserWebviewRect = { left: number; top: number; width: number; height: number };

/** Sekme sürüklenirken bölmenin bırakma vurgusu: tüm içerik ya da bölünecek yarı. */
export type BrowserDropHighlight = 'full' | 'left' | 'right' | 'top' | 'bottom';

/** Kalıcı webview katmanının bir sekme için uyguladığı yerleşim. */
export type BrowserWebviewPlacement = {
  rect: BrowserWebviewRect;
  /** Sekme şu an kullanıcıya gösteriliyorsa true; değilse webview gizli ama canlı kalır. */
  visible: boolean;
  /** Fare olaylarını alabilir mi (sürükleme sırasında false). */
  interactive: boolean;
  /** Webview'e odaklanınca etkinleşecek bölmenin view-scope kimliği. */
  scopeId: string | undefined;
  highlight: BrowserDropHighlight | null;
  /** Vurgunun hesaplandığı bölge: sekme içeriğinin tamamı (araç çubuğu dahil). */
  region: BrowserWebviewRect | null;
};

/** Hiç gösterilmemiş bir sekmenin gizli webview boyutu (ajanlar için makul bir masaüstü). */
export const DEFAULT_HIDDEN_WEBVIEW_RECT: BrowserWebviewRect = {
  left: 0,
  top: 0,
  width: 1280,
  height: 800,
};

type ClaimState = {
  readonly id: number;
  rect: BrowserWebviewRect | null;
  interactive: boolean;
  scopeId: string | undefined;
  highlight: BrowserDropHighlight | null;
  region: BrowserWebviewRect | null;
};

export type BrowserWebviewClaimPatch = Partial<Omit<ClaimState, 'id'>>;

/** Sekme içeriğindeki yer tutucunun, webview'i kendi konumunda gösterme talebi. */
export type BrowserWebviewClaim = {
  update(patch: BrowserWebviewClaimPatch): void;
  release(): void;
};

/**
 * Sekme içerikleri (yer tutucular) ile kalıcı webview katmanı arasındaki ortak durum.
 *
 * Webview'ler görev görünümünden bağımsız, uygulama düzeyindeki bir katmanda yaşar; böylece
 * kullanıcı başka bir göreve geçince sayfa yok olmaz. Görünür bir sekme, yer tutucusunun
 * dikdörtgenini burada "talep" eder; katman webview'i oraya taşır. Talep yoksa webview gizli
 * (visibility:hidden + inert) ama yüklü kalır.
 */
export class BrowserWebviewHostStore {
  private readonly claims = observable.map<string, readonly ClaimState[]>({}, { deep: false });
  private readonly registered = observable.set<string>();
  private readonly loaders = new Map<string, (url: string) => void>();
  private readonly pendingLoads = new Map<string, string>();
  private readonly lastRects = new Map<string, BrowserWebviewRect>();
  private lastAnyRect: BrowserWebviewRect | null = null;
  private nextClaimId = 1;

  constructor() {
    makeObservable<BrowserWebviewHostStore, 'updateClaim' | 'releaseClaim'>(this, {
      claim: action,
      updateClaim: action,
      releaseClaim: action,
      setRegistered: action,
      forget: action,
    });
  }

  /** Webview'i yer tutucunun konumunda göstermek için talep açar; son talep geçerlidir. */
  claim(browserId: string, initial: BrowserWebviewClaimPatch = {}): BrowserWebviewClaim {
    const state = observable.object<ClaimState>(
      {
        id: this.nextClaimId++,
        rect: null,
        interactive: true,
        scopeId: undefined,
        highlight: null,
        region: null,
      },
      {},
      { deep: false }
    );
    this.claims.set(browserId, [...(this.claims.get(browserId) ?? []), state]);
    this.updateClaim(browserId, state, initial);
    return {
      update: (patch) => this.updateClaim(browserId, state, patch),
      release: () => this.releaseClaim(browserId, state),
    };
  }

  placement(browserId: string): BrowserWebviewPlacement {
    const stack = this.claims.get(browserId);
    const claim = stack?.[stack.length - 1];
    if (claim?.rect) {
      return {
        rect: claim.rect,
        visible: true,
        interactive: claim.interactive,
        scopeId: claim.scopeId,
        highlight: claim.highlight,
        region: claim.region,
      };
    }
    return {
      rect: this.lastRects.get(browserId) ?? this.lastAnyRect ?? DEFAULT_HIDDEN_WEBVIEW_RECT,
      visible: false,
      interactive: false,
      scopeId: claim?.scopeId,
      highlight: null,
      region: null,
    };
  }

  /** Katman, ana süreçte oturum kaydı tamamlanınca işaretler; sekme "hazırlanıyor" durumunu okur. */
  setRegistered(browserId: string, registered: boolean): void {
    if (registered) this.registered.add(browserId);
    else this.registered.delete(browserId);
  }

  isRegistered(browserId: string): boolean {
    return this.registered.has(browserId);
  }

  /** Katmandaki webview girdisi, sekmeden gelen adres yükleme isteklerini karşılar. */
  attachLoader(browserId: string, loader: (url: string) => void): () => void {
    this.loaders.set(browserId, loader);
    const pending = this.pendingLoads.get(browserId);
    if (pending !== undefined) {
      this.pendingLoads.delete(browserId);
      loader(pending);
    }
    return () => {
      if (this.loaders.get(browserId) === loader) this.loaders.delete(browserId);
    };
  }

  load(browserId: string, url: string): void {
    const loader = this.loaders.get(browserId);
    if (loader) loader(url);
    else this.pendingLoads.set(browserId, url);
  }

  /** Oturum kapandığında sekmeye ait tüm durumu bırakır. */
  forget(browserId: string): void {
    this.claims.delete(browserId);
    this.registered.delete(browserId);
    this.loaders.delete(browserId);
    this.pendingLoads.delete(browserId);
    this.lastRects.delete(browserId);
  }

  private updateClaim(browserId: string, state: ClaimState, patch: BrowserWebviewClaimPatch): void {
    if (patch.rect !== undefined && !sameRect(state.rect, patch.rect)) {
      state.rect = patch.rect;
      if (patch.rect && patch.rect.width > 0 && patch.rect.height > 0) {
        this.lastRects.set(browserId, patch.rect);
        this.lastAnyRect = patch.rect;
      }
    }
    if (patch.interactive !== undefined && state.interactive !== patch.interactive) {
      state.interactive = patch.interactive;
    }
    if ('scopeId' in patch && state.scopeId !== patch.scopeId) state.scopeId = patch.scopeId;
    if (patch.highlight !== undefined && state.highlight !== patch.highlight) {
      state.highlight = patch.highlight;
    }
    if (patch.region !== undefined && !sameRect(state.region, patch.region)) {
      state.region = patch.region;
    }
  }

  private releaseClaim(browserId: string, state: ClaimState): void {
    const stack = this.claims.get(browserId);
    if (!stack?.includes(state)) return;
    const next = stack.filter((candidate) => candidate !== state);
    if (next.length > 0) this.claims.set(browserId, next);
    else this.claims.delete(browserId);
  }
}

function sameRect(a: BrowserWebviewRect | null, b: BrowserWebviewRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export const browserWebviewHost = new BrowserWebviewHostStore();
