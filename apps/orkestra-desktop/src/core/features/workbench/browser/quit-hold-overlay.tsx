import { useEffect, useState } from 'react';
import { getDesktopWireClient } from '@renderer/lib/runtime/desktop-wire-client';

const HINT_VISIBLE_MS = 1500;

/**
 * Yanlışlıkla ⌘Q / Ctrl+Q basıldığında çalışan ajan oturumlarını korumak için
 * ekranın üst-ortasında kısa süreli çift-basış uyarısı gösterir (T3 Code stili).
 */
export function QuitHoldOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let disposed = false;
    let hideTimer: number | undefined;
    let unsubscribe: (() => void) | undefined;

    void getDesktopWireClient().then(async (client) => {
      const nextUnsubscribe = await client.host.events.subscribe(undefined, {
        onEvent: (event) => {
          if (event.type !== 'quit-shortcut-hint') return;
          setVisible(true);
          window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(() => setVisible(false), HINT_VISIBLE_MS);
        },
        onGap: () => {},
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });

    return () => {
      disposed = true;
      window.clearTimeout(hideTimer);
      unsubscribe?.();
    };
  }, []);

  if (!visible) return null;

  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
  const shortcut = isMac ? '⌘Q' : 'Ctrl+Q';

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[20%] z-[200] flex justify-center animate-in fade-in zoom-in-95 duration-150"
    >
      <div className="rounded-full border border-border-1 bg-foreground/95 px-6 py-3 text-base font-semibold text-background shadow-2xl">
        Çıkmak için {shortcut} tuşuna tekrar basın
      </div>
    </div>
  );
}
