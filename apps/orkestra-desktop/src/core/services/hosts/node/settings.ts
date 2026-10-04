import type { HostSettings } from '@core/primitives/app-settings/api';
import { defineSettingsContribution } from '@core/primitives/settings/api';
import { hostSettingsSchemaContribution } from '../contributions/settings';
import { DEFAULT_WORKSPACE_SERVER_INSTALL_BASE_URL } from './workspace-server/provision/installer';

// The schema is contributed from the shared contributions surface; the
// defaults read process.env, so the full contribution is assembled here and
// aggregated by the node settings manifest.
export const hostSettingsContribution = defineSettingsContribution<'remoteMachine', HostSettings>({
  ...hostSettingsSchemaContribution,
  defaults: () => ({
    installBaseUrl:
      process.env['ORKESTRA_WORKSPACE_SERVER_ARTIFACTS_URL'] ||
      DEFAULT_WORKSPACE_SERVER_INSTALL_BASE_URL,
  }),
});
