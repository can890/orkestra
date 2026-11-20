/**
 * Tema tercihi: Mac Orkestra'nın imzası olan koyu tema varsayılandır; kullanıcı Ayarlar'dan
 * Koyu / Açık / Sistem arasında anında geçiş yapabilir.
 */

export type ThemeMode = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'orkestra.mobile.theme';
const listeners = new Set<() => void>();
let currentMode: ThemeMode = loadInitialTheme();

function loadInitialTheme(): ThemeMode {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
  } catch {
    // Depolama erişilemiyorsa varsayılan koyu tema.
  }
  return 'dark';
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const resolved =
    mode === 'system'
      ? globalThis.matchMedia?.('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b0c0e' : '#f6f7f9');
}

export function getThemeMode(): ThemeMode {
  return currentMode;
}

export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // yoksay
  }
  applyTheme(mode);
  for (const listener of listeners) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initTheme(): void {
  applyTheme(currentMode);
  if (typeof globalThis.matchMedia === 'function') {
    const media = globalThis.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener?.('change', () => {
      if (currentMode === 'system') applyTheme('system');
    });
  }
}
