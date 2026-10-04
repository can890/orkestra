import { describe, expect, it } from 'vitest';
import {
  defaultOrkestraConfig,
  ORKESTRA_CONFIG_FILE,
  isOrkestraConfigPath,
  parseOrkestraConfig,
} from './orkestra-config';

describe('isOrkestraConfigPath', () => {
  it('matches root config paths across path styles', () => {
    expect(isOrkestraConfigPath(`/repo/${ORKESTRA_CONFIG_FILE}`)).toBe(true);
    expect(isOrkestraConfigPath(ORKESTRA_CONFIG_FILE)).toBe(true);
    expect(isOrkestraConfigPath('C:\\repo\\.orkestra.json')).toBe(true);
  });

  it('does not match unrelated files', () => {
    expect(isOrkestraConfigPath('/repo/src/index.ts')).toBe(false);
    expect(isOrkestraConfigPath('/repo/.orkestra.json.bak')).toBe(false);
  });
});

describe('parseOrkestraConfig', () => {
  it('filters the config file from preserve patterns', () => {
    expect(
      parseOrkestraConfig(JSON.stringify({ preservePatterns: ['.env', ORKESTRA_CONFIG_FILE] }))
    ).toEqual({
      success: true,
      data: { preservePatterns: ['.env'] },
    });
  });

  it('silently ignores stale keys from retired features (excludePatterns)', () => {
    expect(
      parseOrkestraConfig(JSON.stringify({ excludePatterns: ['**'], preservePatterns: ['.env'] }))
    ).toEqual({
      success: true,
      data: { preservePatterns: ['.env'] },
    });
  });

  it('has no built-in preserve defaults', () => {
    expect(defaultOrkestraConfig()).toEqual({});
    expect(parseOrkestraConfig('{}')).toEqual({ success: true, data: {} });
  });

  it('returns defaults and the parse error for invalid content', () => {
    const result = parseOrkestraConfig('{');
    expect(result.success).toBe(false);
    expect(result.data).toEqual(defaultOrkestraConfig());
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});
