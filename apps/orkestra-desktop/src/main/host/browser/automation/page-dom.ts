/**
 * Sayfa betiğinin (page-script.ts) kullandığı DOM alt kümesinin yapısal tipleri.
 *
 * Ana süreç programı (tsconfig.node.json) DOM kütüphanesini içermez; betik tarayıcıda
 * çalışsa da burada derlenir. Tüm programa DOM tiplerini sızdırmamak için yalnızca
 * kullandığımız üyeleri tanımlarız. Gerçek DOM nesneleri bu arayüzlerle yapısal olarak
 * uyumludur.
 */

export interface PageRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface PageList<T> {
  readonly length: number;
  readonly [index: number]: T;
}

export interface PageStyle {
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
  readonly cursor: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly paddingLeft: string;
  readonly paddingTop: string;
  readonly contentVisibility?: string;
}

export interface PageEvent {
  readonly type: string;
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly defaultPrevented: boolean;
}

export type PageEventInit = { bubbles?: boolean; cancelable?: boolean; composed?: boolean };

export interface PageNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  textContent: string | null;
  readonly parentNode: PageNode | null;
  readonly childNodes: PageList<PageNode>;
  readonly isConnected: boolean;
  readonly ownerDocument: PageDocument | null;
  contains(other: PageNode | null): boolean;
}

export interface PageOption extends PageNode {
  readonly value: string;
  readonly label: string;
  readonly text: string;
  selected: boolean;
  readonly disabled: boolean;
}

export interface PageElement extends PageNode {
  readonly tagName: string;
  readonly localName: string;
  readonly id: string;
  readonly className: unknown;
  readonly parentElement: PageElement | null;
  readonly shadowRoot: PageShadowRoot | null;
  readonly isContentEditable?: boolean;
  readonly innerText?: string;
  readonly clientLeft: number;
  readonly clientTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  scrollTop: number;
  scrollLeft: number;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): PageRect;
  getClientRects(): PageList<PageRect>;
  getRootNode(): PageNode;
  matches(selector: string): boolean;
  closest(selector: string): PageElement | null;
  querySelector(selector: string): PageElement | null;
  querySelectorAll(selector: string): PageList<PageElement>;
  scrollIntoView(options?: { block?: string; inline?: string; behavior?: string }): void;
  scrollBy(options: { left?: number; top?: number; behavior?: string }): void;
  focus(options?: { preventScroll?: boolean }): void;
  blur?(): void;
  dispatchEvent(event: PageEvent): boolean;
  checkVisibility?(options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }): boolean;
  // Form denetimleri ve özel öğeler; yalnızca ilgili öğelerde bulunur.
  readonly type?: string;
  value?: string;
  readonly checked?: boolean;
  readonly indeterminate?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly multiple?: boolean;
  readonly size?: number;
  readonly open?: boolean;
  readonly placeholder?: string;
  readonly labels?: PageList<PageElement> | null;
  readonly control?: PageElement | null;
  readonly options?: PageList<PageOption>;
  readonly selectedOptions?: PageList<PageOption>;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
  readonly contentDocument?: PageDocument | null;
  setSelectionRange?(start: number, end: number): void;
  assignedNodes?(options?: { flatten?: boolean }): PageNode[];
}

export interface PageShadowRoot extends PageNode {
  readonly host: PageElement;
  readonly activeElement: PageElement | null;
  elementFromPoint(x: number, y: number): PageElement | null;
  getElementById(id: string): PageElement | null;
  querySelectorAll(selector: string): PageList<PageElement>;
}

export interface PageRange {
  selectNodeContents(node: PageNode): void;
  collapse(toStart?: boolean): void;
}

export interface PageSelection {
  readonly rangeCount: number;
  removeAllRanges(): void;
  addRange(range: PageRange): void;
  selectAllChildren(node: PageNode): void;
  toString(): string;
}

export interface PageDocument extends PageNode {
  readonly documentElement: PageElement | null;
  readonly body: PageElement | null;
  readonly title: string;
  readonly activeElement: PageElement | null;
  readonly scrollingElement: PageElement | null;
  readonly defaultView: PageWindow | null;
  readonly readyState: string;
  elementFromPoint(x: number, y: number): PageElement | null;
  getElementById(id: string): PageElement | null;
  querySelectorAll(selector: string): PageList<PageElement>;
  createRange(): PageRange;
  execCommand(command: string): boolean;
}

export interface PageVisualViewport {
  readonly scale: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

export type PageEventConstructor = new (type: string, init?: PageEventInit) => PageEvent;

export interface PageWindow {
  readonly document: PageDocument;
  readonly location: { readonly href: string };
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly devicePixelRatio: number;
  readonly visualViewport: PageVisualViewport | null;
  readonly frameElement: PageElement | null;
  readonly Event: PageEventConstructor;
  readonly HTMLInputElement: { readonly prototype: object };
  readonly HTMLTextAreaElement: { readonly prototype: object };
  getComputedStyle(element: PageElement): PageStyle;
  getSelection(): PageSelection | null;
  addEventListener(type: string, listener: (event: PageEvent) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: PageEvent) => void, capture?: boolean): void;
}
