import { describe, expect, it, vi } from 'vitest';
import { toUpdateCardStatus } from './update-card-status';

const actions = () => ({ openRelease: vi.fn(async () => {}), install: vi.fn(async () => {}) });

describe('toUpdateCardStatus', () => {
  it('claims "up to date" only after a successful check', () => {
    expect(toUpdateCardStatus({ status: 'not-available' }, undefined, actions())).toEqual({
      type: 'up-to-date',
    });
    expect(toUpdateCardStatus({ status: 'idle' }, undefined, actions())).toEqual({
      type: 'not-checked',
    });
    expect(toUpdateCardStatus({ status: 'checking' }, undefined, actions())).toEqual({
      type: 'checking',
    });
    expect(
      toUpdateCardStatus({ status: 'error', message: 'GitHub’a ulaşılamadı' }, undefined, actions())
    ).toEqual({ type: 'check-failed' });
  });

  it('offers the release page for a newer version, also after a later failed check', async () => {
    const handlers = actions();
    const available = toUpdateCardStatus(
      { status: 'available', info: { version: '1.2.18' } },
      undefined,
      handlers
    );
    expect(available).toMatchObject({ type: 'manual-download', version: '1.2.18' });
    if (available.type !== 'manual-download') throw new Error('expected manual-download');
    await available.onOpen();
    expect(handlers.openRelease).toHaveBeenCalledTimes(1);
    expect(handlers.install).not.toHaveBeenCalled();

    expect(
      toUpdateCardStatus({ status: 'error', message: 'zaman aşımı' }, '1.2.18', handlers)
    ).toMatchObject({ type: 'manual-download', version: '1.2.18' });
  });
});
