/**
 * Android MainActivity (`SovraNative`) köprüsü: dokunsal geri bildirim (haptic) ve yerel
 * bildirimler. Tarayıcı/test ortamında sessizce no-op olur.
 */

export type HapticKind = 'light' | 'medium' | 'success' | 'warning';

type SovraNativeApi = {
  setSystemBars?: (dark: boolean) => void;
  haptic?: (kind: string) => void;
  notify?: (id: number, title: string, body: string, urgent: boolean) => void;
};

function nativeApi(): SovraNativeApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { SovraNative?: SovraNativeApi }).SovraNative;
}

export function triggerHaptic(kind: HapticKind = 'light'): void {
  try {
    const api = nativeApi();
    if (api?.haptic) {
      api.haptic(kind);
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(kind === 'warning' ? 30 : kind === 'medium' ? 18 : 10);
    }
  } catch {
    // Dokunsal geri bildirim desteklenmiyorsa yoksay.
  }
}

let nextNotifId = 1000;

export function showNativeNotification(
  title: string,
  body: string,
  options?: { urgent?: boolean; id?: number }
): void {
  try {
    const api = nativeApi();
    if (!api?.notify) return;
    const id = options?.id ?? nextNotifId++;
    api.notify(id, title.slice(0, 120), body.slice(0, 400), options?.urgent === true);
  } catch {
    // Bildirim izni veya köprü yoksa yoksay.
  }
}
