import { CollectionToolbar, CollectionView, PageLayout } from '@orkestra/ui/react/patterns';
import { Button } from '@orkestra/ui/react/primitives';
import { PlusIcon, ServerIcon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { pickLeastLoadedMachine } from '@core/features/machines/api/least-loaded-machine';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { SettingsPageProps } from '@core/primitives/settings/api/page-contribution';
import type { ConnectionState } from '@core/primitives/ssh/api';
import { MachineListRow } from '../components/machine-list-row';
import { createMachinesListView, type MachinesListViewModel } from '../machines-list-model';

function isRecentlyUsed(state: ConnectionState): boolean {
  return state === 'connected' || state === 'connecting' || state === 'reconnecting';
}

export const MachinesSettingsPage = observer(function MachinesSettingsPage({
  openDetail,
}: SettingsPageProps) {
  const machinesStore = getMachinesStore();
  const openMachineModal = useOpenModal('addSshConnModal');
  const [metricsById, setMetricsById] = useState<
    Record<string, { cpuPercent: number; memoryPercent: number }>
  >({});

  const connectedIdsKey = machinesStore.connections
    .filter((m) => machinesStore.stateFor(m.id) === 'connected')
    .map((m) => m.id)
    .join(',');

  useEffect(() => {
    const ids = connectedIdsKey ? connectedIdsKey.split(',') : [];
    if (ids.length === 0) {
      setMetricsById({});
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const client = await getMachinesClient();
        const entries = await Promise.all(
          ids.map(async (id) => {
            try {
              const sample = await client.getMachineMetrics({ machineId: id });
              return [
                id,
                {
                  cpuPercent: sample.cpu.usedPercent,
                  memoryPercent: sample.memory.usedPercent,
                },
              ] as const;
            } catch {
              return null;
            }
          })
        );
        if (!cancelled) {
          const next: Record<string, { cpuPercent: number; memoryPercent: number }> = {};
          for (const entry of entries) {
            if (entry) next[entry[0]] = entry[1];
          }
          setMetricsById(next);
        }
      } catch {
        // Ağ hatasını sessizce geç
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connectedIdsKey]);

  const recommendedMachineId = useMemo(() => {
    const connected = machinesStore.connections.filter(
      (m) => machinesStore.stateFor(m.id) === 'connected'
    );
    if (connected.length < 2) return null;
    return pickLeastLoadedMachine(
      connected.map((m) => ({
        id: m.id,
        connected: true,
        cpuPercent: metricsById[m.id]?.cpuPercent,
        memoryPercent: metricsById[m.id]?.memoryPercent,
      }))
    );
  }, [machinesStore, metricsById]);

  // The machines store is MobX-observable, so the view's source getter reads it
  // directly and the list pipeline re-derives on store changes — no bridge needed.
  const [view] = useState(() =>
    createMachinesListView({
      getMachines: () => getMachinesStore().connections,
      isRecentlyUsed: (machine) => isRecentlyUsed(getMachinesStore().stateFor(machine.id)),
    })
  );

  const openCreateModal = () => {
    void openMachineModal({ dismissControl: 'close' });
  };

  return (
    <div className="flex min-h-0 flex-col gap-8">
      <PageLayout.Header
        sticky
        title="Machines"
        description="Manage reusable machines for remote projects."
      />
      <view.Root>
        <CollectionView
          view={view}
          renderRow={(machine) => (
            <MachineListRow
              machine={machine}
              recommended={recommendedMachineId === machine.id}
              cpuPercent={metricsById[machine.id]?.cpuPercent}
              memoryPercent={metricsById[machine.id]?.memoryPercent}
            />
          )}
          layout="grouped"
          toolbar={<MachinesToolbar view={view} onAdd={openCreateModal} />}
          onItemClick={(machine) => openDetail(machine.id)}
          emptySlot={<MachinesEmptyState hasMachines={machinesStore.connections.length > 0} />}
        />
      </view.Root>
    </div>
  );
});

const MachinesToolbar = observer(function MachinesToolbar({
  view,
  onAdd,
}: {
  view: MachinesListViewModel;
  onAdd: () => void;
}) {
  const search = view.useSearch();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        value={search.query}
        onValueChange={search.setQuery}
        placeholder="Search machines…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        <Button type="button" variant="primary" onClick={onAdd}>
          <PlusIcon />
          Add machine
        </Button>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
});

function MachinesEmptyState({ hasMachines }: { hasMachines: boolean }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center p-8 text-center">
      <ServerIcon className="mb-3 size-8 text-foreground-passive" />
      <div className="text-sm text-foreground">
        {hasMachines ? 'No machines match your search' : 'No machines'}
      </div>
      <p className="mt-1 max-w-sm text-xs text-foreground-passive">
        {hasMachines
          ? 'Try a different name, host, or username.'
          : 'Add a machine to create and manage remote projects.'}
      </p>
    </div>
  );
}
