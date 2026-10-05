import type { WebContents } from 'electron';
import type { BrowserPageAutomation } from '@core/primitives/browser/api/agent-browser';

/**
 * Bir sekmenin WebContents'i için sayfa kontrolcüsü oluşturur. Yer tutucu: gerçek uygulama
 * (anlık görüntü, güvenilir tıklama/klavye, ekran görüntüsü, konsol) bu dosyanın yerini alır.
 */
export function createPageAutomation(_webContents: WebContents): BrowserPageAutomation {
  throw new Error('Tarayıcı otomasyonu henüz uygulanmadı');
}
