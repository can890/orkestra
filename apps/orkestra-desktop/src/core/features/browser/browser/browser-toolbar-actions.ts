import { toast } from '@orkestra/ui/react/primitives';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { openModal } from '@core/manifests/browser/modal-api';
import {
  normalizeBrowserUrl,
  type BrowserDataClearKind,
  type BrowserSessionSnapshot,
} from '@core/primitives/browser/api';
import type { BrowserRecordingStatus } from '@core/primitives/browser/api/agent-browser';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import type { BrowserWebviewAdapter } from './browser-webview-types';

export function openBrowserUrlExternally(url: string): void {
  if (!canOpenBrowserUrlExternally(url)) return;
  const normalized = normalizeBrowserUrl(url);
  if (normalized.ok) {
    void openExternal(normalized.url);
  }
}

export function canOpenBrowserUrlExternally(url: string): boolean {
  const normalized = normalizeBrowserUrl(url);
  return normalized.ok && (normalized.protocol === 'http:' || normalized.protocol === 'https:');
}

export async function captureBrowserScreenshot(session: BrowserSessionSnapshot): Promise<void> {
  const result = await (
    await getBrowserClient()
  ).captureScreenshot({
    browserId: session.browserId,
  });
  if (result.success) {
    toast('Screenshot copied to clipboard');
  } else {
    toast.error('Could not capture screenshot');
  }
}

export function clearBrowserData(
  session: BrowserSessionSnapshot,
  kind: BrowserDataClearKind,
  onSuccess: () => void
): Promise<void> {
  return getBrowserClient()
    .then((client) => client.clearData({ browserId: session.browserId, kind }))
    .then((result) => {
      if (result.success) {
        onSuccess();
        return;
      }

      toast.error('Could not clear browser data', {
        description: 'Try again, or reload the browser view manually.',
      });
    })
    .catch((error: unknown) => {
      console.error('Failed to clear browser data', error);
      toast.error('Could not clear browser data', {
        description: error instanceof Error ? error.message : 'The browser data request failed.',
      });
    });
}

export function confirmClearBrowserStorage(
  session: BrowserSessionSnapshot,
  adapter: BrowserWebviewAdapter | null,
  profileLabel = 'this browser profile'
): void {
  void openModal('confirmActionModal', {
    title: 'Clear browser storage?',
    description: `This clears cookies, local storage, IndexedDB, and cache for ${profileLabel}. Browser tabs using the same storage boundary will be signed out.`,
    confirmLabel: 'Clear Storage',
    variant: 'destructive',
  }).then((outcome) => {
    if (outcome.success) {
      void clearBrowserData(session, 'storage', () => adapter?.reload());
    }
  });
}

/** Sekmenin eylem kaydının durumu; sorgu başarısızsa null. */
export async function fetchBrowserRecordingStatus(
  browserId: string
): Promise<BrowserRecordingStatus | null> {
  try {
    const result = await (await getBrowserClient()).recording({ browserId, action: 'status' });
    return result.success ? (result.status ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Kaydı başlatır (kullanıcının ve ajanın eylemleri) ya da sürüyorsa durdurur; yeni durumu
 * döndürür.
 */
export async function toggleBrowserRecording(
  browserId: string,
  recording: boolean
): Promise<BrowserRecordingStatus | null> {
  try {
    const result = await (
      await getBrowserClient()
    ).recording({ browserId, action: recording ? 'stop' : 'start' });
    if (!result.success) {
      toast.error(recording ? 'Kayıt durdurulamadı' : 'Kayıt başlatılamadı', {
        description: result.error,
      });
      return null;
    }
    if (recording) {
      toast(`Kayıt durduruldu: ${result.steps?.length ?? 0} adım`, {
        description: 'Adımları "Kaydı kopyala (JSON)" ile alıp ajana verebilirsiniz.',
      });
    } else {
      toast('Kayıt başladı', {
        description: 'Bu sekmedeki tıklama, yazma ve gezinmeleriniz adım olarak kaydediliyor.',
      });
    }
    return result.status ?? null;
  } catch (error) {
    toast.error('Kayıt işlemi başarısız', {
      description: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Süren ya da son kaydın adımlarını JSON olarak panoya kopyalar. */
export async function copyBrowserRecording(browserId: string): Promise<void> {
  try {
    const result = await (await getBrowserClient()).recording({ browserId, action: 'steps' });
    const steps = result.success ? (result.steps ?? []) : [];
    if (steps.length === 0) {
      toast.error('Kopyalanacak kayıt yok');
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(steps, null, 2));
    toast(`Kayıt panoya kopyalandı (${steps.length} adım)`);
  } catch (error) {
    toast.error('Kayıt kopyalanamadı', {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}
