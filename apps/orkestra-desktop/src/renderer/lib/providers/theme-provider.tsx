import { useCallback, useEffect, type ReactNode } from 'react';
import { useCustomAppearance } from '@core/features/appearance/browser/use-custom-appearance';
import { monacoBootstrap } from '@core/features/editor/browser/monaco/monaco-bootstrap';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { applyThemeToAll } from '@core/features/terminals/api/browser/pty/pty';
import type { AccentPreset, FontScale } from '@core/primitives/app-settings/api';
import { ThemeProvider as CoreThemeProvider } from '@core/primitives/theme/browser';

const ACCENT_TOKENS: Record<
  Exclude<AccentPreset, 'default'>,
  { c9: string; c10: string; c11: string; contrast: string }
> = {
  ocean: { c9: '#0284c7', c10: '#0369a1', c11: '#38bdf8', contrast: '#ffffff' },
  emerald: { c9: '#059669', c10: '#047857', c11: '#34d399', contrast: '#ffffff' },
  amber: { c9: '#d97706', c10: '#b45309', c11: '#fbbf24', contrast: '#111827' },
  violet: { c9: '#7c3aed', c10: '#6d28d9', c11: '#a78bfa', contrast: '#ffffff' },
  rose: { c9: '#e11d48', c10: '#be123c', c11: '#fb7185', contrast: '#ffffff' },
};

const FONT_SCALE_CSS: Record<FontScale, string | null> = {
  compact: '94%',
  default: null,
  comfortable: '106%',
};

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const { value, isLoading, update } = useAppSettingsKey('theme');
  const { value: iface } = useAppSettingsKey('interface');
  const handleThemeApplied = useCallback(() => applyThemeToAll(), []);
  // Özel tema/CSS/arka plan görseli (Görünüm özelleştirme).
  const customAppearance = useCustomAppearance();
  const themeClassOverride = customAppearance.themeClassOverride;

  // Özel tema etkinken vurgu ön ayarı uygulanmaz; renkler temanın paletinden gelir.
  const accentPreset: AccentPreset = themeClassOverride
    ? 'default'
    : (iface?.accentPreset ?? 'default');
  const fontScale: FontScale = iface?.fontScale ?? 'default';

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.accent = accentPreset;
    root.dataset.fontScale = fontScale;

    if (accentPreset === 'default') {
      root.style.removeProperty('--em-accent-9');
      root.style.removeProperty('--em-accent-10');
      root.style.removeProperty('--em-accent-11');
      root.style.removeProperty('--em-accent-contrast');
    } else {
      const tokens = ACCENT_TOKENS[accentPreset];
      root.style.setProperty('--em-accent-9', tokens.c9);
      root.style.setProperty('--em-accent-10', tokens.c10);
      root.style.setProperty('--em-accent-11', tokens.c11);
      root.style.setProperty('--em-accent-contrast', tokens.contrast);
    }

    const cssScale = FONT_SCALE_CSS[fontScale];
    if (cssScale) {
      root.style.fontSize = cssScale;
    } else {
      root.style.removeProperty('font-size');
    }
  }, [accentPreset, fontScale]);

  // Özel tema değişkenleri değişince terminal ve Monaco renkleri CSS'ten yeniden okunur.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    applyThemeToAll();
    const effective = document.documentElement.classList.contains('emlight') ? 'emlight' : 'emdark';
    monacoBootstrap.setTheme(effective);
  }, [customAppearance.revision]);

  return (
    <CoreThemeProvider
      theme={themeClassOverride ?? value ?? null}
      isLoading={isLoading}
      onThemeChange={update}
      onThemeApplied={handleThemeApplied}
    >
      {children}
      {customAppearance.overlay}
    </CoreThemeProvider>
  );
}
