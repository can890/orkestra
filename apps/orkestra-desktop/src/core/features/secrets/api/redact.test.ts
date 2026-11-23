import { describe, expect, it } from 'vitest';
import { containsSensitiveSecret, redactSensitiveText } from './redact';

describe('secrets/redact', () => {
  it('masks API keys, tokens, PEM blocks, op:// refs, and secret env vars', () => {
    const sample = [
      'OPENAI_API_KEY=sk-proj-abc12345678901234567890',
      'ANTHROPIC=sk-ant-api03-abcdef123456789012',
      'GH=ghp_1234567890abcdefghij1234567890',
      'AWS=AKIAIOSFODNN7EXAMPLE',
      'REF=op://Private/OpenAI/credential',
      'Authorization: Bearer mySuperSecretToken12345',
      'MY_CUSTOM_SECRET="verysecretvalue999"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQE...\n-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const redacted = redactSensitiveText(sample);
    expect(containsSensitiveSecret(sample)).toBe(true);
    expect(redacted).not.toContain('sk-proj-abc');
    expect(redacted).not.toContain('sk-ant-api03');
    expect(redacted).not.toContain('ghp_1234');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).not.toContain('op://Private/OpenAI/credential');
    expect(redacted).not.toContain('mySuperSecretToken12345');
    expect(redacted).not.toContain('verysecretvalue999');
    expect(redacted).not.toContain('MIIEowIBAAKCAQE');
    expect(redacted).toContain('OPENAI_API_KEY=[GİZLENDİ]');
    expect(redacted).toContain('MY_CUSTOM_SECRET="[GİZLENDİ]"');
  });

  it('leaves normal prose and code identifiers untouched', () => {
    const clean = 'Merhaba, settings-contributions.ts dosyasında taskId alanı güncellendi.';
    expect(containsSensitiveSecret(clean)).toBe(false);
    expect(redactSensitiveText(clean)).toBe(clean);
  });
});
