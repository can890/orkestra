import { describe, expect, it, vi } from 'vitest';
import { collectHistoryTurns, handoffTitle, type HistoryPageResult } from './handoff-history';

const turn = (seq: number) => ({ id: `t${seq}`, seq, items: [] });
const page = (
  turns: ReturnType<typeof turn>[],
  nextCursor: number | null,
  unavailable?: true
): HistoryPageResult => ({
  success: true,
  data: { turns, nextCursor, ...(unavailable ? { unavailable } : {}) },
});

describe('collectHistoryTurns', () => {
  it('sayfaları eskiden yeniye birleştirir', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(page([turn(3), turn(4)], 3))
      .mockResolvedValueOnce(page([turn(1), turn(2)], null));
    const turns = await collectHistoryTurns(load);
    expect(turns.map((t) => t.seq)).toEqual([1, 2, 3, 4]);
    expect(load).toHaveBeenNthCalledWith(1, undefined);
    expect(load).toHaveBeenNthCalledWith(2, 3);
  });

  it('sayfa sayısını sınırlar', async () => {
    const load = vi.fn().mockResolvedValue(page([turn(1)], 1));
    await collectHistoryTurns(load);
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('okunamayınca ekrandaki turlara düşer', async () => {
    const load = vi.fn().mockResolvedValue({ success: false, error: 'x' });
    expect(await collectHistoryTurns(load, [turn(9)])).toEqual([turn(9)]);
    const unavailable = vi.fn().mockResolvedValue(page([], null, true));
    expect(await collectHistoryTurns(unavailable, [turn(9)])).toEqual([turn(9)]);
  });

  it('yedek yokken okuma hatası fırlatır; kullanılamaz geçmiş boş döner', async () => {
    await expect(
      collectHistoryTurns(vi.fn().mockResolvedValue({ success: false, error: 'x' }))
    ).rejects.toThrow('okunamadı');
    expect(await collectHistoryTurns(vi.fn().mockResolvedValue(page([], null, true)))).toEqual([]);
  });
});

describe('handoffTitle', () => {
  it('eki ekler ve başlık sınırını aşmaz', () => {
    expect(handoffTitle('Hata', 'fork')).toBe('Hata (çatal)');
    expect(handoffTitle('Hata', 'handoff')).toBe('Hata (devir)');
    expect(handoffTitle('a'.repeat(500), 'fork').length).toBeLessThanOrEqual(100);
    expect(handoffTitle('  ', 'fork')).toBe('Sohbet (çatal)');
  });
});
