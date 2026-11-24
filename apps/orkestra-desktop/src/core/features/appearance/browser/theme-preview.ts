// Tema düzenleyicisinin canlı önizlemesi: kaydedilmemiş taslak tema burada tutulur ve uygulayıcı
// onu etkin temanın yerine gösterir. Düzenleyici kapanınca önizleme temizlenir.

import { useSyncExternalStore } from 'react';
import type { CustomTheme } from '../api/custom-theme-schema';

let preview: CustomTheme | null = null;
const listeners = new Set<() => void>();

export function setThemePreview(theme: CustomTheme | null): void {
  if (preview === theme) return;
  preview = theme;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreview(): CustomTheme | null {
  return useSyncExternalStore(
    subscribe,
    () => preview,
    () => null
  );
}
