import { defineSettingsContribution } from '@core/primitives/settings/api';
import {
  DEFAULT_MEDIA_PROVIDERS_SETTINGS,
  mediaProvidersSettingsSchema,
  type MediaProvidersSettings,
} from '../api/media-providers-model';

/** Higgsfield ve Flow medya sağlayıcıları (ikisi de varsayılan kapalı). */
export const mediaProvidersSettingsContribution = defineSettingsContribution<
  'mediaProviders',
  MediaProvidersSettings
>({
  key: 'mediaProviders',
  schema: mediaProvidersSettingsSchema,
  defaults: DEFAULT_MEDIA_PROVIDERS_SETTINGS,
});
