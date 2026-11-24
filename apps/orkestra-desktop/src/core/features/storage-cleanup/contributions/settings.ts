import { defineSettingsContribution } from '@core/primitives/settings/api';
import {
  DEFAULT_STORAGE_CLEANUP_SETTINGS,
  storageCleanupSettingsSchema,
  type StorageCleanupSettings,
} from '../api/settings';

/** Depolama temizliği politikaları (bu makine); varsayılan olarak hepsi kapalı. */
export const storageCleanupSettingsContribution = defineSettingsContribution<
  'storageCleanup',
  StorageCleanupSettings
>({
  key: 'storageCleanup',
  schema: storageCleanupSettingsSchema,
  defaults: DEFAULT_STORAGE_CLEANUP_SETTINGS,
});
