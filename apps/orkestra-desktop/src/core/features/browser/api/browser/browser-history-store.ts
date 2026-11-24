import { action, makeObservable, observable } from 'mobx';
import { normalizeBrowserUrl } from '@core/primitives/browser/api';

const STORAGE_KEY = 'orkestra:browser-recent-urls';
const MAX_HISTORY_ENTRIES = 12;

export type BrowserHistoryEntry = {
  url: string;
  title: string;
  visitedAt: number;
};

function readInitialHistory(): BrowserHistoryEntry[] {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is BrowserHistoryEntry =>
          Boolean(item) &&
          typeof item.url === 'string' &&
          typeof item.title === 'string' &&
          typeof item.visitedAt === 'number'
      )
      .slice(0, MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

function persistHistory(entries: readonly BrowserHistoryEntry[]): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Depolama kotası aşımında sessizce yoksay.
  }
}

export class BrowserHistoryStore {
  entries: BrowserHistoryEntry[] = readInitialHistory();

  constructor() {
    makeObservable(this, {
      entries: observable,
      recordVisit: action,
      removeEntry: action,
      clear: action,
    });
  }

  recordVisit(url: string, title = ''): void {
    const trimmed = url.trim();
    if (!trimmed || trimmed === 'about:blank') return;
    const normalized = normalizeBrowserUrl(trimmed, { allowSearchQueries: false });
    if (!normalized.ok || (normalized.protocol !== 'http:' && normalized.protocol !== 'https:')) {
      return;
    }
    const canonical = normalized.url;
    const nextTitle = title.trim() || canonical;
    const filtered = this.entries.filter((entry) => entry.url !== canonical);
    this.entries = [{ url: canonical, title: nextTitle, visitedAt: Date.now() }, ...filtered].slice(
      0,
      MAX_HISTORY_ENTRIES
    );
    persistHistory(this.entries);
  }

  removeEntry(url: string): void {
    const next = this.entries.filter((entry) => entry.url !== url);
    if (next.length === this.entries.length) return;
    this.entries = next;
    persistHistory(this.entries);
  }

  clear(): void {
    this.entries = [];
    persistHistory(this.entries);
  }
}

export const browserHistoryStore = new BrowserHistoryStore();
