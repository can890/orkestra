import { describe, expect, it } from 'vitest';
import { appearanceSettingsContribution, DEFAULT_APPEARANCE_SETTINGS } from './settings';

const schema = appearanceSettingsContribution.schema;

describe('appearance settings schema', () => {
  it('fills defaults for an empty stored value', () => {
    expect(schema.parse({})).toEqual(DEFAULT_APPEARANCE_SETTINGS);
  });

  it('keeps valid themes, drops invalid and duplicate ones', () => {
    const good = {
      id: 'ocean',
      name: 'Ocean',
      polarity: 'dark',
      palette: { background: '#0b1d2a', accent: '#2aa7d6' },
    };
    const parsed = schema.parse({
      customThemes: [good, { ...good, name: 'dup' }, { id: 'light', name: 'x' }, 42],
      activeCustomThemeId: 'ocean',
    });
    expect(parsed.customThemes.map((theme) => theme.id)).toEqual(['ocean']);
    expect(parsed.customThemes[0]).toMatchObject({ contrast: 'normal', vividness: 1.15 });
    expect(parsed.activeCustomThemeId).toBe('ocean');
  });

  it('rejects background file names that could escape the app data folder', () => {
    const parsed = schema.parse({
      background: { enabled: true, fileName: '../../etc/passwd', opacity: 1, blur: 0, dim: 0.8 },
    });
    expect(parsed.background.fileName).toBeNull();
  });
});
