import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { SubagentRoutingSettingsPage } from '../browser/subagent-routing-settings-page';

export const subagentRoutingSettingsPage = defineSettingsPageContribution({
  id: 'subagent-routing',
  label: 'Sub-agent routing',
  icon: 'route',
  component: SubagentRoutingSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
