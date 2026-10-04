import { hostRef, LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { Select } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import { McpPanel } from '@core/features/mcp/contributions/browser/McpPanel';

export const ApplicationIntegrationsCatalog = observer(function ApplicationIntegrationsCatalog() {
  const machines = getMachinesStore().connections;
  const [machineId, setMachineId] = useState('local');
  const machine = machines.find((item) => item.id === machineId);
  const host = machine ? hostRef('remote', machine.id) : LOCAL_HOST_REF;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm">Uygulama ve servis kataloğu</h3>
        <Select.Root
          value={machine?.id ?? 'local'}
          onValueChange={(value) => value && setMachineId(value)}
        >
          <Select.Trigger aria-label="Entegrasyonların kullanılacağı makine">
            <Select.Value>{machine?.name ?? 'Bu bilgisayar'}</Select.Value>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="local">Bu bilgisayar</Select.Item>
            {machines.map((item) => (
              <Select.Item key={item.id} value={item.id}>
                {item.name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>
      <p className="text-sm text-foreground-muted">
        Önce ajanların çalıştığı makineyi seçin. Servis kartındaki “Hesabı bağla” veya “Hesabı
        yeniden bağla” düğmesiyle tarayıcıda giriş yapın. Bağlantı yalnızca seçtiğiniz makineye
        kaydedilir; her makine için ayrı bağlantı kurun.
      </p>
      <McpPanel
        key={`${host.type}:${host.id}`}
        host={host}
        hostLabel={machine?.name ?? 'Bu bilgisayar'}
        applicationCatalog
      />
    </div>
  );
});
