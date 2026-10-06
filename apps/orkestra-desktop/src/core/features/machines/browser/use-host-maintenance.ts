import { toast } from '@orkestra/ui/react/primitives';
import { remote, type RemoteModel } from '@orkestra/wire/state';
import { useCallback, useEffect } from 'react';
import { useRemoteModelState } from '@core/primitives/wire/browser/use-remote-model-state';
import { getHostMaintenanceClient } from '@core/services/hosts/api/maintenance-client';
import {
  hostMaintenanceContract,
  type HostMaintenanceState,
  type ServerActivity,
} from '@core/services/hosts/api/maintenance-contract';

let maintenanceRemotePromise:
  | Promise<RemoteModel<typeof hostMaintenanceContract.states>>
  | undefined;

export type HostMaintenanceActions = {
  check(): Promise<void>;
  inspectActivity(): Promise<ServerActivity | undefined>;
  updateNow(): Promise<void>;
  inspectHealth(): Promise<void>;
  prune(): Promise<void>;
};

/** Bir makinenin workspace-server bakım durumunu ve eylemlerini sunar. */
export function useHostMaintenance({
  machineId,
  connected,
}: {
  machineId: string | undefined;
  connected: boolean;
}): { state: HostMaintenanceState | undefined; actions: HostMaintenanceActions } {
  const runtime = useRemoteModelState(
    hostMaintenanceContract.states,
    getMaintenanceRemote,
    undefined,
    'runtime',
    { enabled: machineId !== undefined, initialValue: {} }
  );
  const state = connected && machineId ? runtime.value?.[machineId] : undefined;
  const hasHealth = state?.health !== undefined;

  // Sayfa açıldığında sağlık bilgisi yoksa bir kez oku; sürüm denetimi arka planda zaten çalışır.
  useEffect(() => {
    if (!connected || !machineId || !runtime.ready || hasHealth) return;
    void getHostMaintenanceClient()
      .then((client) => client.inspectHealth({ connectionId: machineId }))
      .catch(() => {});
  }, [connected, hasHealth, machineId, runtime.ready]);

  const run = useCallback(
    async <T>(
      operation: (connectionId: string) => Promise<T>,
      failure: string
    ): Promise<T | undefined> => {
      if (!machineId) return undefined;
      try {
        return await operation(machineId);
      } catch (error) {
        toast.error(failure, {
          description: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
    [machineId]
  );

  const actions: HostMaintenanceActions = {
    check: async () => {
      await run(
        async (connectionId) => (await getHostMaintenanceClient()).check({ connectionId }),
        'Sunucu sürümü denetlenemedi'
      );
    },
    inspectActivity: () =>
      run(
        async (connectionId) =>
          (await getHostMaintenanceClient()).inspectActivity({ connectionId }),
        'Sunucu etkinliği okunamadı'
      ),
    updateNow: async () => {
      await run(
        async (connectionId) => (await getHostMaintenanceClient()).updateNow({ connectionId }),
        'Sunucu güncellenemedi'
      );
    },
    inspectHealth: async () => {
      await run(
        async (connectionId) => (await getHostMaintenanceClient()).inspectHealth({ connectionId }),
        'Sunucu sağlığı okunamadı'
      );
    },
    prune: async () => {
      const result = await run(
        async (connectionId) => (await getHostMaintenanceClient()).pruneVersions({ connectionId }),
        'Eski sürümler temizlenemedi'
      );
      if (result) {
        toast.success(
          result.removed.length === 0
            ? 'Temizlenecek eski sürüm yok'
            : `${result.removed.length} eski sürüm temizlendi`
        );
      }
    },
  };

  return { state, actions };
}

function getMaintenanceRemote(): Promise<RemoteModel<typeof hostMaintenanceContract.states>> {
  maintenanceRemotePromise ??= getHostMaintenanceClient().then((client) =>
    remote(hostMaintenanceContract.states, client.states, { lingerMs: 15_000 })
  );
  return maintenanceRemotePromise;
}
