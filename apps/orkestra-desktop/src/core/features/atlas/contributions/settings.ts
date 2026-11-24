import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';
import { DEFAULT_ATLAS_SETTINGS, type AtlasSettings } from '../api/atlas-model';

/** Atlas bağlantısı: arama kaynağı ve otomatik oturum kartı (ikisi de varsayılan kapalı). */
export const atlasSettingsContribution = defineSettingsContribution<'atlas', AtlasSettings>({
  key: 'atlas',
  schema: z.object({
    searchEnabled: z.boolean().default(false),
    autoCardEnabled: z.boolean().default(false),
    cardLanguage: z.enum(['tr', 'en']).default('tr'),
    executable: z.string().max(1024).default(''),
  }),
  defaults: DEFAULT_ATLAS_SETTINGS,
});
