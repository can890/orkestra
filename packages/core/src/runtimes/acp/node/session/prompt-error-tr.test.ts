import { describe, expect, it } from 'vitest';
import { promptErrorMessageTr } from './prompt-error-tr';
describe('Turkish prompt failures', () => {
  it('preserves the quota reset instead of suggesting a connection failure', () => {
    const text = promptErrorMessageTr(
      'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h7m0s.'
    );
    expect(text).toContain('kullanım limiti doldu');
    expect(text).toContain('3 saat 7 dakika');
    expect(text).not.toContain('bağlantı');
  });
  it.each([
    'not logged in',
    'model unavailable',
    'ACP connection closed',
    'timeout',
    'attachment missing',
  ])('translates %s', (message) => {
    expect(promptErrorMessageTr(message)).not.toContain(message);
  });
  it('does not expose unknown provider errors', () => {
    expect(promptErrorMessageTr('Internal error: secret=private')).not.toContain('private');
  });
});
