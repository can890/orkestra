import { homedir } from 'node:os';
import { recordLoadedManagedPolicy } from '@orkestra/shared/managed-policy/node';
import { app, dialog } from 'electron';
import { getActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';
import { loadManagedPolicyAtStartup } from '@main/host/managed-policy/load-managed-policy';
import { log } from '@main/lib/logger';
import type { AppConfig } from '../../core/config';
import { BootAborted } from '../types';

/**
 * Yönetilen politikayı yükler. Geçersizse kurtarma moduna da girmeden (o da politikayı atlatmanın
 * bir yolu olurdu) açık bir hata göstererek çıkar.
 */
export async function loadManagedPolicy(config: AppConfig): Promise<void> {
  // Kaynaktan çalışan derlemeler politikayı root olmadan deneyebilsin; yayın derlemesinde
  // kullanıcının ayarlayabildiği her geçersiz kılma politikayı atlatırdı.
  const decision = await loadManagedPolicyAtStartup({ allowPathOverride: config.isDev });
  if (decision.kind === 'start') {
    const active = getActiveManagedPolicy();
    // `policy show` çalışan sürecin hangi politikayı yüklediğini bu dosyadan okur. Politika
    // yoksa yeni dosya yazılmaz; yalnızca önceki bir politikadan kalan kayıt silinir.
    void recordLoadedManagedPolicy(
      homedir(),
      active
        ? {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            policy: {
              source: active.source,
              organization: active.summary.organization,
              fingerprint: active.fingerprint,
            },
          }
        : null
    ).catch((error: unknown) => {
      log.warn('Could not record the loaded managed policy', { error });
    });
    if (active) {
      log.info('Managed policy applies', {
        source: active.source,
        organization: active.summary.organization,
        fingerprint: active.fingerprint,
        lockedSettings: active.summary.lockedSettings,
      });
    }
    return;
  }

  log.error(decision.message);
  process.stderr.write(`${decision.message}\n`);
  if (process.env.SOVRA_HEADLESS !== '1') {
    dialog.showErrorBox('Orkestra cannot start', decision.message);
  }
  app.exit(decision.exitCode);
  throw new BootAborted(decision.message);
}
