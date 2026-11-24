/**
 * Tema tercihi: Mac Sovra'nın imzası olan koyu obsidyen tema varsayılandır; kullanıcı Ayarlar'dan
 * Koyu / Açık / Sistem arasında anında geçiş yapabilir.
 */

export type ThemeMode = 'dark' | 'light' | 'system';

declare global {
  interface Window {
    SovraNative?: {
      setSystemBars?: (dark: boolean) => void;
    };
  }
}

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
  const isDark = resolved === 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark ? '#090a0d' : '#f5f7fa');
  try {
    window.SovraNative?.setSystemBars?.(isDark);
  } catch {
    // Web/test ortamında native köprü yoktur.
  }
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
