import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { AtlasSettingsPage } from '../browser/atlas-settings-page';

export const atlasSettingsPage = defineSettingsPageContribution({
  id: 'atlas',
  label: 'Atlas',
  icon: 'library',
  component: AtlasSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
