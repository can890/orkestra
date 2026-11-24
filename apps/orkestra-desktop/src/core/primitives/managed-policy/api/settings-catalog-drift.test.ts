import { MANAGEABLE_SETTINGS } from '@orkestra/shared/managed-policy';
import { describe, expect, it } from 'vitest';
import { appSettingsContributions } from '@core/manifests/node/settings-contributions';

// Politikanın yönetebildiği her ayar yolu gerçek bir ayar katkısında bulunmalı ve katalog şeması
// ile katkı şeması aynı değerleri kabul etmeli: ayarlar değişince politika sessizce kopmasın.
describe('managed settings catalog', () => {
  for (const [path, entry] of Object.entries(MANAGEABLE_SETTINGS)) {
    it(`${path} exists in the settings contributions`, () => {
      const [key, field] = path.split('.') as [keyof typeof appSettingsContributions, string];
      const contribution = appSettingsContributions[key];
      expect(contribution, `unknown settings key ${key}`).toBeDefined();
      const defaults =
        typeof contribution.defaults === 'function'
          ? (contribution.defaults as () => unknown)()
          : contribution.defaults;
      expect(defaults).toHaveProperty(field);
      const defaultValue = (defaults as Record<string, unknown>)[field];
      expect(entry.schema.safeParse(defaultValue).success).toBe(true);
      // Katalogdaki her değer gerçek ayar şemasından da geçmeli.
      const candidate = { ...(defaults as Record<string, unknown>), [field]: defaultValue };
      expect(contribution.schema.safeParse(candidate).success).toBe(true);
    });
  }
});
