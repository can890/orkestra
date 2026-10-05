import type { NotificationService } from '../notification-service';

export function publishUpdateAvailableNotification(
  service: Pick<NotificationService, 'publish'>,
  version: string
): string {
  return service.publish({
    kind: 'update-available',
    groupKey: 'app-update',
    dedupeKey: `update-available:${version}`,
    title: 'Yeni sürüm var',
    body: `Orkestra ${version} yayımlandı. İndirmek için tıklayın.`,
    sound: null,
    target: { kind: 'update', version },
    source: { kind: 'app' },
  });
}

export function publishUpdateDownloadedNotification(
  service: Pick<NotificationService, 'publish'>,
  version: string
): string {
  return service.publish({
    kind: 'update-downloaded',
    groupKey: 'app-update',
    dedupeKey: `update:${version}`,
    title: 'Update ready',
    body: `Orkestra ${version} has been downloaded and will install on restart.`,
    sound: null,
    target: { kind: 'update', version },
    source: { kind: 'app' },
  });
}

export function publishUpdateErrorNotification(
  service: Pick<NotificationService, 'publish'>,
  message: string
): string {
  return service.publish({
    kind: 'update-error',
    groupKey: 'app-update',
    dedupeKey: `update-error:${message}`,
    title: 'Update failed',
    body: message,
    sound: null,
    target: { kind: 'update' },
    source: { kind: 'app' },
  });
}
