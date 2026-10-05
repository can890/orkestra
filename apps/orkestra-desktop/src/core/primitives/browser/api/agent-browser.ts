/**
 * Ajanların Orkestra içi tarayıcıyı kullanması için taşınabilir sözleşme. Electron'dan
 * bağımsızdır: ana süreç (main/host/browser) bu arayüzleri gerçek WebContents ile uygular,
 * core tarafındaki ajan araçları yalnızca bu tiplere dayanır ve bootstrap'ta bağlanır.
 */

/** Ana sürecin bildiği, bir göreve ait tarayıcı sekmesi. */
export type AgentBrowserTab = {
  browserId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
  url: string;
  title: string;
  /** Sekme, görevinin panelinde şu an gösterilen tarayıcı sekmesiyse true. */
  active: boolean;
  /** Sekmenin sayfası (webview) şu an yüklü ve kontrol edilebilir durumdaysa true. */
  live: boolean;
};

/**
 * Sayfadaki bir hedef: son anlık görüntüdeki (snapshot) öğe referansı ya da sayfanın görünür
 * alanındaki CSS piksel koordinatı.
 */
export type BrowserElementTarget = { ref: string } | { x: number; y: number };

export type BrowserKeyModifier = 'shift' | 'control' | 'alt' | 'meta';

export type BrowserPageInfo = { url: string; title: string };

/** Sayfanın ajan için özeti: etkileşimli öğeler `[ref=e12]` biçiminde referans taşır. */
export type BrowserSnapshot = BrowserPageInfo & { outline: string; truncated: boolean };

export type BrowserScreenshot = {
  mimeType: 'image/png';
  /** Base64 PNG verisi. */
  data: string;
  width: number;
  height: number;
};

export type BrowserConsoleEntry = {
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  source?: string;
  line?: number;
  /** Epoch milisaniye. */
  time: number;
};

/**
 * Tek bir sekmenin sayfasını süren işlemler. Uygulama tıklama ve klavye için güvenilir
 * (trusted) giriş olayları kullanır; referanslar yalnızca en son `snapshot` çağrısından
 * sonra geçerlidir ve sayfa değişince geçersiz sayılır.
 */
export interface BrowserPageAutomation {
  navigate(url: string, options?: { timeoutMs?: number }): Promise<BrowserPageInfo>;
  goBack(): Promise<BrowserPageInfo>;
  goForward(): Promise<BrowserPageInfo>;
  reload(): Promise<BrowserPageInfo>;
  snapshot(options?: { maxChars?: number }): Promise<BrowserSnapshot>;
  click(
    target: BrowserElementTarget,
    options?: {
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      modifiers?: BrowserKeyModifier[];
    }
  ): Promise<void>;
  hover(target: BrowserElementTarget): Promise<void>;
  /** `target` null ise metin odaktaki öğeye yazılır. */
  type(
    target: BrowserElementTarget | null,
    text: string,
    options?: { clear?: boolean; submit?: boolean }
  ): Promise<void>;
  /** Ör. "Enter", "Tab", "Escape", "ArrowDown", "Control+A", "Meta+L". */
  pressKey(key: string): Promise<void>;
  scroll(options: {
    target?: BrowserElementTarget;
    direction?: 'up' | 'down' | 'left' | 'right';
    /** Piksel; verilmezse görünür alanın yaklaşık yüzde 80'i. */
    amount?: number;
  }): Promise<void>;
  /** Seçilen seçeneklerin değerlerini döndürür. */
  selectOption(target: BrowserElementTarget, values: string[]): Promise<string[]>;
  waitFor(options: {
    text?: string;
    textGone?: string;
    timeMs?: number;
    timeoutMs?: number;
  }): Promise<{ satisfied: boolean }>;
  screenshot(options?: { fullPage?: boolean }): Promise<BrowserScreenshot>;
  getText(options?: { maxChars?: number }): Promise<{ text: string; truncated: boolean }>;
  /** Sayfada bir ifade çalıştırır; sonuç JSON'a dönüştürülebilir bir değer olmalıdır. */
  evaluate(expression: string): Promise<unknown>;
  consoleMessages(options?: {
    sinceMs?: number;
    limit?: number;
    clear?: boolean;
  }): BrowserConsoleEntry[];
  dispose(): void;
}

/** Ajan araçlarının tarayıcıya eriştiği tek kapı; ana süreç uygular, bootstrap bağlar. */
export interface AgentBrowserPort {
  listTabs(scope: { projectId: string; taskId: string }): AgentBrowserTab[];
  getTab(browserId: string): AgentBrowserTab | null;
  /**
   * Görevin çalışma alanında yeni bir tarayıcı sekmesi açar ve sayfası kontrol edilebilir
   * olduğunda (WebContents bağlandığında) çözülür. Kullanıcının baktığı görünümü değiştirmez.
   */
  openTab(input: {
    projectId: string;
    workspaceId: string;
    taskId: string;
    url?: string;
    /** Sekmeyi panelinde öne getir (varsayılan true). */
    activate?: boolean;
  }): Promise<AgentBrowserTab>;
  activateTab(browserId: string): Promise<void>;
  closeTab(browserId: string): Promise<void>;
  /** Canlı bir sekmenin sayfa kontrolcüsü; sekme yoksa ya da yüklü değilse null. */
  page(browserId: string): BrowserPageAutomation | null;
}
