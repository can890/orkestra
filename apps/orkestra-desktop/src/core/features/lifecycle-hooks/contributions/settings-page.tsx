import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { LifecycleHooksNavIcon } from '../browser/LifecycleHooksNavIcon';
import { LifecycleHooksSettingsPage } from '../browser/LifecycleHooksSettingsPage';

export const lifecycleHooksSettingsPage = defineSettingsPageContribution({
  id: 'lifecycle-hooks',
  label: 'Kancalar',
  icon: <LifecycleHooksNavIcon />,
  component: LifecycleHooksSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
