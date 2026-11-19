import {
  extractDeepLinkFromArgv,
  parseDeepLink,
  type DeepLinkRoute,
  type DeepLinkTarget,
} from '@core/primitives/deep-links/api/deep-link';

/** Pencere hazır olmadan gelen bağlantılar kaybolmasın; ama sınırsız da birikmesin. */
const MAX_PENDING = 5;

export interface DeepLinkSink {
  /** Arayüze "bekleyen bağlantı var" der (içerik taşımaz). */
  notifyPending(): void;
  focusWindow(): void;
}

export type DeepLinkResolver = (route: DeepLinkRoute) => Promise<DeepLinkTarget>;

/**
 * Dış dünyadan gelen derin bağlantıların sırası. Elektron'dan bağımsızdır. Bağlantılar
 * yalnızca gezinme hedefi olarak çözülür; burada hiçbir eylem yürütülmez. Soğuk
 * başlatmada bağlantı pencere/arayüz hazır olana kadar sırada bekler: arayüz hazır
 * olunca `takePending` ile alır.
 */
export class DeepLinkCoordinator {
  private pending: DeepLinkRoute[] = [];
  private sink: DeepLinkSink | undefined;

  constructor(private readonly scheme: string) {}

  /** macOS `open-url` ya da herhangi bir ham bağlantı metni. Geçersizse sessizce yok sayılır. */
  handleUrl(raw: unknown): boolean {
    const route = parseDeepLink(raw, this.scheme);
    if (!route) return false;
    this.pending.push(route);
    if (this.pending.length > MAX_PENDING)
      this.pending.splice(0, this.pending.length - MAX_PENDING);
    this.sink?.notifyPending();
    this.sink?.focusWindow();
    return true;
  }

  /** Windows/Linux ilk argv ve `second-instance`: yalnızca şema ile başlayan tek değer alınır. */
  handleArgv(argv: readonly unknown[]): boolean {
    const raw = extractDeepLinkFromArgv(argv, this.scheme);
    return raw === undefined ? false : this.handleUrl(raw);
  }

  /** Pencere hazır olunca bağlanır; o ana dek sıraya girenler için bildirim gönderilir. */
  attach(sink: DeepLinkSink): void {
    this.sink = sink;
    if (this.pending.length > 0) sink.notifyPending();
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  async takePending(resolve: DeepLinkResolver): Promise<DeepLinkTarget[]> {
    const routes = this.pending;
    this.pending = [];
    const targets: DeepLinkTarget[] = [];
    for (const route of routes) {
      try {
        targets.push(await resolve(route));
      } catch {
        targets.push({ kind: 'not-found', route });
      }
    }
    return targets;
  }
}
