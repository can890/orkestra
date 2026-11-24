import { LOCAL_HOST_REF, type HostRef } from '@orkestra/core/primitives/host/api';
import type { McpServer } from '@orkestra/core/primitives/mcp/api';
import { SettingsRow } from '@orkestra/ui/react/patterns';
import { Switch } from '@orkestra/ui/react/primitives';
import { remote, type RemoteModel } from '@orkestra/wire/state';
import { useMemo } from 'react';
import { mcpContract } from '@core/features/mcp/api';
import { getMcpClient } from '@core/features/mcp/api/browser/client';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { useRemoteModelState } from '@core/primitives/wire/browser/use-remote-model-state';

let serversRemotePromise: Promise<RemoteModel<typeof mcpContract.servers>> | undefined;

function getServersRemote(): Promise<RemoteModel<typeof mcpContract.servers>> {
  serversRemotePromise ??= getMcpClient().then((client) =>
    remote(mcpContract.servers, client.servers, { lingerMs: 15_000 })
  );
  return serversRemotePromise;
}

function useConfiguredServers(host: HostRef): McpServer[] {
  const key = useMemo(() => ({ host }), [host]);
  const state = useRemoteModelState(mcpContract.servers, getServersRemote, key, 'list', {
    initialValue: [],
  });
  return state.value ?? [];
}

/**
 * MCP ayarları sayfasında "Etkileşimli uygulamalar" bölümü: genel anahtar (varsayılan açık) ve
 * sunucu başına kapatma. Kapalı bir sunucunun uygulaması geçmişte de gösterilmez; araç çağrısı
 * normal satır olarak kalır.
 */
export function McpAppsSettingsSection() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('mcpApps');
  const servers = useConfiguredServers(LOCAL_HOST_REF);
  const enabled = value?.enabled ?? true;
  const disabledServers = value?.disabledServers ?? [];
  const busy = isLoading || isSaving;
  const title = 'Show interactive apps from MCP servers';

  const setServerEnabled = (name: string, on: boolean) => {
    const others = disabledServers.filter((entry) => entry !== name);
    update({ disabledServers: on ? others : [...others, name] });
  };

  return (
    <section className="mt-6 flex flex-col gap-2" aria-label="Interactive MCP apps">
      <SettingsRow
        label={title}
        description="Some MCP servers return an interactive app with their tool results. Orkestra shows it in the chat below the tool call, in a sandbox without access to Orkestra or your files. Apps ask before running tools that change something and before every message they send. Works for MCP servers configured for an agent on this computer."
        control={
          <Switch
            aria-label={title}
            checked={enabled}
            disabled={busy}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />
      {enabled && servers.length > 0 ? (
        <div className="flex flex-col gap-1 pl-4">
          {servers.map((server) => {
            const label = `Apps from ${server.name}`;
            return (
              <SettingsRow
                key={server.name}
                label={label}
                control={
                  <Switch
                    aria-label={label}
                    checked={!disabledServers.includes(server.name)}
                    disabled={busy}
                    onCheckedChange={(checked) => setServerEnabled(server.name, checked)}
                  />
                }
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
