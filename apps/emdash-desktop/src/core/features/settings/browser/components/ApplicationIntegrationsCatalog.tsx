import { hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { Select } from '@emdash/ui/react/primitives';
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
        Servisi seçin, gerekli hesap bilgilerini girin ve kullanacak ajanları belirleyin. Kaydedilen
        bağlantılar seçtiğiniz makinenin ajan ayarlarına eklenir. Hesap gerektiren servislerde
        ayrıca giriş yapılmalıdır.
      </p>
      <McpPanel key={`${host.type}:${host.id}`} host={host} applicationCatalog />
    </div>
  );
});
