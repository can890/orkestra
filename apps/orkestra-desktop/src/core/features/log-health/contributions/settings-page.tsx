import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { LogHealthNavIcon } from '../browser/LogHealthNavIcon';
import { LogHealthSettingsPage } from '../browser/LogHealthSettingsPage';

export const logHealthSettingsPage = defineSettingsPageContribution({
  id: 'log-health',
  label: 'Günlük sağlığı',
  icon: <LogHealthNavIcon />,
  component: LogHealthSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
