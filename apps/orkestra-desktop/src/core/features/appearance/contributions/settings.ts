import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';
import {
  BACKGROUND_FILE_NAME_RE,
  DEFAULT_BACKGROUND_SETTINGS,
  MAX_BACKGROUND_BLUR_PX,
  type BackgroundSettings,
} from '../api/background';
import { CUSTOM_CSS_MAX_LENGTH } from '../api/custom-css';
import { customThemeSchema, MAX_CUSTOM_THEMES, type CustomTheme } from '../api/custom-theme-schema';

export type CustomCssSettings = {
  enabled: boolean;
  css: string;
  /** Kullanıcının "Koru" ile onayladığı CSS'in özeti; onaysız CSS açılışta uygulanmaz. */
  confirmedHash: string | null;
};

export type AppearanceSettings = {
  customThemes: CustomTheme[];
  /** Etkin özel tema; null ise yerleşik tema (Tema ayarı) kullanılır. */
  activeCustomThemeId: string | null;
  customCss: CustomCssSettings;
  background: BackgroundSettings;
};

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  customThemes: [],
  activeCustomThemeId: null,
  customCss: { enabled: false, css: '', confirmedHash: null },
  background: DEFAULT_BACKGROUND_SETTINGS,
};

// Bozuk tek bir tema tüm listeyi düşürmesin: geçersiz girdiler atlanır.
const customThemesSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = customThemeSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })
  )
  .transform((themes) => {
    const seen = new Set<string>();
    return themes
      .filter((theme) => !seen.has(theme.id) && seen.add(theme.id))
      .slice(0, MAX_CUSTOM_THEMES);
  });

const appearanceSettingsSchema = z.object({
  customThemes: customThemesSchema.catch([]).default([]),
  activeCustomThemeId: z.string().nullable().catch(null).default(null),
  customCss: z
    .object({
      enabled: z.boolean().catch(false),
      css: z.string().max(CUSTOM_CSS_MAX_LENGTH).catch(''),
      confirmedHash: z.string().nullable().catch(null).default(null),
    })
    .catch(DEFAULT_APPEARANCE_SETTINGS.customCss)
    .default(DEFAULT_APPEARANCE_SETTINGS.customCss),
  background: z
    .object({
      enabled: z.boolean().catch(false),
      fileName: z.string().regex(BACKGROUND_FILE_NAME_RE).nullable().catch(null),
      opacity: z.number().min(0).max(1).catch(DEFAULT_BACKGROUND_SETTINGS.opacity),
      blur: z.number().min(0).max(MAX_BACKGROUND_BLUR_PX).catch(DEFAULT_BACKGROUND_SETTINGS.blur),
      dim: z.number().min(0).max(1).catch(DEFAULT_BACKGROUND_SETTINGS.dim),
    })
    .catch(DEFAULT_BACKGROUND_SETTINGS)
    .default(DEFAULT_BACKGROUND_SETTINGS),
});

export const appearanceSettingsContribution = defineSettingsContribution<
  'appearance',
  AppearanceSettings
>({
  key: 'appearance',
  schema: appearanceSettingsSchema,
  defaults: DEFAULT_APPEARANCE_SETTINGS,
});
