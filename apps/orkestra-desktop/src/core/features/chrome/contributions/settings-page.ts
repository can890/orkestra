import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { ChromeSettingsPage } from '../browser/chrome-settings-page';

export const chromeSettingsPage = defineSettingsPageContribution({
  id: 'chrome',
  label: 'Chrome',
  icon: 'globe',
  component: ChromeSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
