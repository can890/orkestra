// Görünüm özelleştirmelerini uygular: etkin (ya da önizlenen) özel tema, kullanıcı CSS'i
// (onay şeridi ve açılış güvenliğiyle) ve sohbet yüzeyinin arka plan görseli.

import { toast } from '@orkestra/ui/react/primitives';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { BACKGROUND_IMAGE_VARIABLE, backgroundStylesheet } from '../api/background';
import { getAppearanceClient } from '../api/browser/client';
import { hashCustomCss, SAFE_ZONE_ATTRIBUTE } from '../api/custom-css';
import { deriveThemeVars, themeStylesheet, type CustomTheme } from '../api/custom-theme';
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from '../contributions/settings';
import { applyCustomCss } from './custom-css-sheet';
import { useThemePreview } from './theme-preview';

const THEME_STYLE_ID = 'orkestra-custom-theme';
const BACKGROUND_STYLE_ID = 'orkestra-background-image';
/** Onaylanmamış CSS bu süre sonunda kendiliğinden geri alınır. */
export const CUSTOM_CSS_CONFIRM_SECONDS = 15;

function upsertStyle(id: string, css: string): void {
  let element = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement('style');
    element.id = id;
    // Uygulamanın katmanlı stillerinden sonra, katmansız: tema değişkenleri kazanır.
    document.head.appendChild(element);
  }
  if (element.textContent !== css) element.textContent = css;
}

/** Kurtarma kısayolu: ⌘⌥⇧C (macOS) / Ctrl+Alt+Shift+C — özel CSS'i kapatır. */
export function isCustomCssRescueShortcut(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
): boolean {
  return (
    event.code === 'KeyC' && (event.metaKey || event.ctrlKey) && event.altKey && event.shiftKey
  );
}

export type CustomAppearanceState = {
  /** Özel tema etkinse onun kutup sınıfı; değilse undefined (yerleşik tema geçerli). */
  themeClassOverride: 'emlight' | 'emdark' | undefined;
  /** Tema değişkenleri değişince artar (Monaco/terminal renklerini yenilemek için). */
  revision: string;
  /** Onay şeridi (portal); sağlayıcı ağacına yerleştirilmelidir. */
  overlay: React.ReactNode;
};

export function useCustomAppearance(): CustomAppearanceState {
  const { value, update, isLoading } = useAppSettingsKey('appearance');
  const settings: AppearanceSettings = value ?? DEFAULT_APPEARANCE_SETTINGS;
  const preview = useThemePreview();
  const activeTheme: CustomTheme | null =
    preview ??
    settings.customThemes.find((theme) => theme.id === settings.activeCustomThemeId) ??
    null;

  // ── Tema ────────────────────────────────────────────────────────────────────
  const themeCss = useMemo(() => {
    if (!activeTheme) return '';
    try {
      return themeStylesheet(activeTheme, deriveThemeVars(activeTheme));
    } catch {
      return '';
    }
  }, [activeTheme]);
  useLayoutEffect(() => {
    upsertStyle(THEME_STYLE_ID, themeCss);
  }, [themeCss]);

  // ── Özel CSS (onay + açılış güvenliği) ─────────────────────────────────────
  const css = settings.customCss;
  const hash = useMemo(() => hashCustomCss(css.css), [css.css]);
  const launchChecked = useRef(false);
  const [disabledAtLaunch, setDisabledAtLaunch] = useState(false);
  useEffect(() => {
    if (isLoading || launchChecked.current) return;
    launchChecked.current = true;
    // Açılışta onaylanmamış CSS uygulanmaz: önceki oturum onaylamadan kapandıysa (ör. CSS
    // arayüzü bozdu ve uygulama zorla kapatıldı) güvenli tarafta kalınır.
    if (css.enabled && css.css.trim() && hash !== css.confirmedHash) {
      setDisabledAtLaunch(true);
      void update({ customCss: { ...css, enabled: false } });
      toast.warning('Custom CSS was turned off', {
        description:
          'It was never confirmed in the last session. Turn it on again in Settings → Interface.',
      });
    }
  }, [isLoading, css, hash, update]);

  const cssActive = !isLoading && !disabledAtLaunch && css.enabled && css.css.trim().length > 0;
  const needsConfirmation = cssActive && hash !== css.confirmedHash;
  useEffect(() => {
    applyCustomCss(cssActive ? css.css : '');
  }, [cssActive, css.css]);
  useEffect(() => {
    if (disabledAtLaunch && !css.enabled) setDisabledAtLaunch(false);
  }, [disabledAtLaunch, css.enabled]);

  const disableCustomCss = useRef<() => void>(() => {});
  disableCustomCss.current = () => {
    if (!css.enabled) return;
    void update({ customCss: { ...css, enabled: false } });
    toast.info('Custom CSS turned off');
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCustomCssRescueShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      disableCustomCss.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // ── Arka plan görseli ──────────────────────────────────────────────────────
  const background = settings.background;
  const fileName = background.enabled ? background.fileName : null;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!fileName) {
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const client = await getAppearanceClient();
        const image = await client.readBackgroundImage({ fileName });
        if (cancelled || !image) return;
        const bytes = Uint8Array.from(atob(image.dataBase64), (c) => c.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
        setImageUrl(objectUrl);
      } catch {
        // Görsel okunamazsa arka plan gösterilmez.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setImageUrl(null);
    };
  }, [fileName]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (imageUrl) root.style.setProperty(BACKGROUND_IMAGE_VARIABLE, `url("${imageUrl}")`);
    else root.style.removeProperty(BACKGROUND_IMAGE_VARIABLE);
    upsertStyle(BACKGROUND_STYLE_ID, imageUrl ? backgroundStylesheet(background) : '');
  }, [imageUrl, background]);

  const overlay = needsConfirmation ? (
    <CustomCssConfirmStrip
      key={hash}
      onKeep={() => void update({ customCss: { ...css, confirmedHash: hash } })}
      onRevert={() => void update({ customCss: { ...css, enabled: false } })}
    />
  ) : null;

  return {
    themeClassOverride: activeTheme
      ? activeTheme.polarity === 'light'
        ? 'emlight'
        : 'emdark'
      : undefined,
    revision: `${themeCss.length}:${activeTheme?.id ?? ''}:${hashCustomCss(themeCss)}`,
    overlay,
  };
}

/**
 * "Bu CSS kalsın mı?" şeridi. Güvenli bölgededir (kullanıcı CSS'i ulaşamaz), yalnızca satır içi
 * sabit renkler kullanır ve onaylanmazsa süre sonunda CSS'i kendiliğinden kapatır.
 */
function CustomCssConfirmStrip({ onKeep, onRevert }: { onKeep: () => void; onRevert: () => void }) {
  const [remaining, setRemaining] = useState(CUSTOM_CSS_CONFIRM_SECONDS);
  const revert = useRef(onRevert);
  revert.current = onRevert;
  useEffect(() => {
    const timer = setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (remaining === 0) revert.current();
  }, [remaining]);
  const button: React.CSSProperties = {
    all: 'unset',
    cursor: 'pointer',
    padding: '4px 10px',
    borderRadius: 6,
    font: '500 12px -apple-system, BlinkMacSystemFont, sans-serif',
  };
  return createPortal(
    <div
      {...{ [SAFE_ZONE_ATTRIBUTE]: '' }}
      role="alertdialog"
      aria-label="Keep custom CSS?"
      style={{
        all: 'initial',
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        zIndex: 2147483647,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderRadius: 10,
        background: '#1f2023',
        color: '#f4f4f5',
        boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
        font: '13px -apple-system, BlinkMacSystemFont, sans-serif',
        visibility: 'visible',
        opacity: 1,
      }}
    >
      <span>Keep these custom CSS changes? Reverting in {remaining} s.</span>
      <button
        type="button"
        style={{ ...button, background: '#f4f4f5', color: '#111113' }}
        onClick={onKeep}
      >
        Keep
      </button>
      <button
        type="button"
        style={{ ...button, background: '#3a3b40', color: '#f4f4f5' }}
        onClick={onRevert}
      >
        Revert
      </button>
    </div>,
    document.body
  );
}
