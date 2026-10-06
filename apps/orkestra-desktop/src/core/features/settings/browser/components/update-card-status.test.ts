import { describe, expect, it, vi } from 'vitest';
import { toUpdateCardStatus, type UpdateCardInfo } from './update-card-status';

const actions = () => ({
  openRelease: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
});

const none: UpdateCardInfo = {
  availableVersion: undefined,
  installMode: undefined,
  manualReason: undefined,
};
const inApp: UpdateCardInfo = { ...none, availableVersion: '1.2.18', installMode: 'in-app' };

describe('toUpdateCardStatus', () => {
  it('claims "up to date" only after a successful check', () => {
    expect(toUpdateCardStatus({ status: 'not-available' }, none, actions())).toEqual({
      type: 'up-to-date',
    });
    expect(toUpdateCardStatus({ status: 'idle' }, none, actions())).toEqual({
      type: 'not-checked',
    });
    expect(toUpdateCardStatus({ status: 'checking' }, none, actions())).toEqual({
      type: 'checking',
    });
    expect(
      toUpdateCardStatus({ status: 'error', message: 'GitHub’a ulaşılamadı' }, none, actions())
    ).toEqual({ type: 'check-failed' });
  });

  it('offers the release page for manual installs, also after a later failed check', async () => {
    const handlers = actions();
    const available = toUpdateCardStatus(
      { status: 'available', info: { version: '1.2.18' } },
      { ...none, installMode: 'manual', manualReason: 'Klasöre yazma izni yok.' },
      handlers
    );
    expect(available).toMatchObject({
      type: 'manual-download',
      version: '1.2.18',
      reason: 'Klasöre yazma izni yok.',
    });
    if (available.type !== 'manual-download') throw new Error('expected manual-download');
    await available.onOpen();
    expect(handlers.openRelease).toHaveBeenCalledTimes(1);
    expect(handlers.download).not.toHaveBeenCalled();

    expect(
      toUpdateCardStatus(
        { status: 'error', message: 'zaman aşımı' },
        { ...none, availableVersion: '1.2.18' },
        handlers
      )
    ).toMatchObject({ type: 'manual-download', version: '1.2.18' });
  });

  it('walks the in-app flow: download, progress, ready to restart, installing', async () => {
    const handlers = actions();
    const available = toUpdateCardStatus(
      { status: 'available', info: { version: '1.2.18' } },
      inApp,
      handlers
    );
    expect(available).toMatchObject({
      type: 'download-available',
      version: '1.2.18',
      retry: false,
    });
    if (available.type !== 'download-available') throw new Error('expected download-available');
    await available.onDownload();
    expect(handlers.download).toHaveBeenCalledTimes(1);

    expect(
      toUpdateCardStatus({ status: 'downloading', progress: { percent: 37.4 } }, inApp, handlers)
    ).toMatchObject({ type: 'downloading', version: '1.2.18', percent: 37.4 });

    const ready = toUpdateCardStatus({ status: 'downloaded' }, inApp, handlers);
    expect(ready).toMatchObject({ type: 'ready-to-restart', version: '1.2.18' });
    if (ready.type !== 'ready-to-restart') throw new Error('expected ready-to-restart');
    await ready.onInstall();
    expect(handlers.install).toHaveBeenCalledTimes(1);
    await ready.onOpenRelease?.();
    expect(handlers.openRelease).toHaveBeenCalledTimes(1);

    expect(toUpdateCardStatus({ status: 'installing' }, inApp, handlers)).toEqual({
      type: 'installing',
    });
  });

  it('offers a retry after a failed in-app download', () => {
    expect(
      toUpdateCardStatus({ status: 'error', message: 'bağlantı koptu' }, inApp, actions())
    ).toMatchObject({ type: 'download-available', version: '1.2.18', retry: true });
  });
});
