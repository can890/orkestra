import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { OutsideAgentsSettingsPage } from '../browser/outside-agents-settings-page';

export const outsideAgentsSettingsPage = defineSettingsPageContribution({
  id: 'outside-agents',
  label: 'Outside agents (MCP)',
  icon: 'bot',
  component: OutsideAgentsSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
