/**
 * PR Saved Views persistence helper (Feature #10 — adapted from T3 Code pullRequestSavedViews.ts).
 */

import type { StatusFilter } from './usePrViewState';

export type PrSavedView = {
  id: string;
  name: string;
  status: StatusFilter;
  author: string | null;
  assignee: string | null;
  labels: string[];
  builtIn?: boolean;
};

const STORAGE_KEY = 'sovra:pr:savedViews:v1';

export const BUILTIN_PR_SAVED_VIEWS: readonly PrSavedView[] = [
  { id: 'builtin-open', name: 'Açık PR’lar', status: 'open', author: null, assignee: null, labels: [], builtIn: true },
  { id: 'builtin-closed', name: 'Kapalı / Birleştirilenler', status: 'not-open', author: null, assignee: null, labels: [], builtIn: true },
];

export function loadCustomPrSavedViews(): PrSavedView[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is PrSavedView => Boolean(v && typeof v.id === 'string' && typeof v.name === 'string')) : [];
  } catch {
    return [];
  }
}

export function saveCustomPrSavedViews(views: readonly PrSavedView[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views.filter((v) => !v.builtIn)));
  } catch {
    // ignore storage failures
  }
}
