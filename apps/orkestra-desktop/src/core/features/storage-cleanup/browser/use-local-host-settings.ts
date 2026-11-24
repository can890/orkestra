import type {
  HostSettings,
  HostSettingsState,
  UpdateHostSettingsInput,
} from '@orkestra/core/runtimes/host-settings/api';
import { remote, type RemoteModel } from '@orkestra/wire/state';
import { useCallback, useMemo } from 'react';
import { machinesContract } from '@core/features/machines/api';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { useRemoteModelState } from '@core/primitives/wire/browser/use-remote-model-state';

let hostSettingsRemotePromise:
  | Promise<RemoteModel<typeof machinesContract.hostSettings>>
  | undefined;

/**
 * Yerel makinenin host ayarlarını (host-settings runtime) machines alanı üzerinden izler
 * ve kısmi güncelleme yazar. Dosyaya dışarıdan yapılan düzenlemeler canlı yansır.
 */
export function useLocalHostSettings(enabled: boolean): {
  settings: HostSettings | undefined;
  isLoading: boolean;
  update: (patch: UpdateHostSettingsInput) => Promise<void>;
} {
  const modelKey = useMemo(() => ({ machineId: undefined }), []);
  const modelState = useRemoteModelState(
    machinesContract.hostSettings,
    getHostSettingsRemote,
    modelKey,
    'current',
    { enabled }
  );
  const update = useCallback(async (patch: UpdateHostSettingsInput) => {
    const client = await getMachinesClient();
    const result = await client.updateHostSettings({ machineId: undefined, patch });
    if (!result.success) throw new Error(result.error.message, { cause: result.error });
  }, []);
  const state: HostSettingsState | undefined = modelState.value;
  return { settings: state?.settings, isLoading: enabled && modelState.isLoading, update };
}

function getHostSettingsRemote(): Promise<RemoteModel<typeof machinesContract.hostSettings>> {
  hostSettingsRemotePromise ??= getMachinesClient().then((client) =>
    remote(machinesContract.hostSettings, client.hostSettings, { lingerMs: 15_000 })
  );
  return hostSettingsRemotePromise;
}
