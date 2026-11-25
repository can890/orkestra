import { describe, expect, it } from 'vitest';
import { handoffTitle, isHandoffLineageTitle } from './handoff-title';

describe('handoffTitle', () => {
  it('kaynak başlığına kipin ekini koyar', () => {
    expect(handoffTitle('Mutfak dolabı', 'context-handoff')).toBe('Mutfak dolabı (devam)');
    expect(handoffTitle('Hata', 'fork')).toBe('Hata (çatal)');
    expect(handoffTitle('Hata', 'handoff')).toBe('Hata (devir)');
    expect(handoffTitle('  ', 'context-handoff')).toBe('Sohbet (devam)');
  });

  it('aynı kipte ikinci devirde eki çoğaltmaz, numaralar', () => {
    expect(handoffTitle('Mutfak dolabı (devam)', 'context-handoff')).toBe(
      'Mutfak dolabı (devam 2)'
    );
    expect(handoffTitle('Mutfak dolabı (devam 2)', 'context-handoff')).toBe(
      'Mutfak dolabı (devam 3)'
    );
    expect(handoffTitle('Hata (çatal)', 'fork')).toBe('Hata (çatal 2)');
  });

  it('başka kipin ekini korur', () => {
    expect(handoffTitle('Hata (çatal)', 'context-handoff')).toBe('Hata (çatal) (devam)');
  });

  it('başlık sınırını aşmaz', () => {
    expect(handoffTitle('a'.repeat(500), 'context-handoff').length).toBeLessThanOrEqual(100);
    expect(handoffTitle(`${'a'.repeat(500)} (devam 9)`, 'context-handoff')).toMatch(
      / \(devam 10\)$/
    );
  });
});

describe('isHandoffLineageTitle', () => {
  it('devir/çatal/bağlam devri başlıklarını tanır', () => {
    expect(isHandoffLineageTitle('Mutfak dolabı (devam)')).toBe(true);
    expect(isHandoffLineageTitle('Mutfak dolabı (devam 12)')).toBe(true);
    expect(isHandoffLineageTitle('Hata (çatal)')).toBe(true);
    expect(isHandoffLineageTitle('Hata (devir)')).toBe(true);
  });

  it('sıradan ve varsayılan başlıkları tanımaz', () => {
    expect(isHandoffLineageTitle('Claude (1)')).toBe(false);
    expect(isHandoffLineageTitle('devam et')).toBe(false);
    expect(isHandoffLineageTitle('(devam)')).toBe(false);
    expect(isHandoffLineageTitle('')).toBe(false);
    expect(isHandoffLineageTitle(null)).toBe(false);
  });
});
