import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { PluginsView } from '../browser/PluginsView';

export const pluginsSettingsPage = defineSettingsPageContribution({
  id: 'plugins',
  label: 'Eklentiler',
  icon: 'plug',
  component: PluginsView,
} satisfies SettingsPageContribution<SettingsPageTab>);
