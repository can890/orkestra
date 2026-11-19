import { describe, expect, it } from 'vitest';
import { stripHiddenContextFromTitle, wrapHiddenContext } from './hidden-context';

describe('stripHiddenContextFromTitle', () => {
  it('keeps a plain title', () => {
    expect(stripHiddenContextFromTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it('removes a complete hidden block', () => {
    expect(stripHiddenContextFromTitle(`Sadece hazır yaz. ${wrapHiddenContext('secret')}`)).toBe(
      'Sadece hazır yaz.'
    );
  });

  it('removes a hidden block the provider truncated before its closing tag', () => {
    expect(
      stripHiddenContextFromTitle(
        "Sadece 'hazır' yaz, başka hiçbir şey yapma. <orkestra_context> Orkestra can display generated files "
      )
    ).toBe("Sadece 'hazır' yaz, başka hiçbir şey yapma.");
  });

  it('removes an open tag that was cut short at the end of the title', () => {
    expect(stripHiddenContextFromTitle('Kısa mesaj <orkestra_con')).toBe('Kısa mesaj');
    expect(stripHiddenContextFromTitle('Kısa mesaj <o')).toBe('Kısa mesaj');
  });

  it('does not touch an unrelated trailing angle bracket word', () => {
    expect(stripHiddenContextFromTitle('Compare a <b')).toBe('Compare a <b');
  });

  it('returns null when nothing visible is left', () => {
    expect(stripHiddenContextFromTitle('<orkestra_context> only hidden')).toBeNull();
    expect(stripHiddenContextFromTitle(wrapHiddenContext('x'))).toBeNull();
  });
});
