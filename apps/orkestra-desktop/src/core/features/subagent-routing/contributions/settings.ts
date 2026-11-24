import { defineSettingsContribution } from '@core/primitives/settings/api';
import {
  DEFAULT_SUBAGENT_ROUTING_SETTINGS,
  subagentRoutingSettingsSchema,
  type SubagentRoutingSettings,
} from '../api/routing-settings';

/** Limit farkındalıklı alt ajan yönlendirmesi (varsayılan kapalı). */
export const subagentRoutingSettingsContribution = defineSettingsContribution<
  'subagentRouting',
  SubagentRoutingSettings
>({
  key: 'subagentRouting',
  schema: subagentRoutingSettingsSchema,
  defaults: DEFAULT_SUBAGENT_ROUTING_SETTINGS,
});
