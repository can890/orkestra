import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { RemoteAccessSettingsPage } from '../browser/RemoteAccessSettingsPage';

export const remoteAccessSettingsPage = defineSettingsPageContribution({
  id: 'remote-access',
  label: 'Mobil erişim',
  icon: 'smartphone',
  component: RemoteAccessSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
