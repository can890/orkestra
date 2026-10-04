import type { HostRef } from '@orkestra/core/primitives/host/api';
import type { McpCatalogEntry, McpServer } from '@orkestra/core/primitives/mcp/api';
import { CardGridSection } from '@orkestra/ui/react/components';
import { Loader2 } from 'lucide-react';
import React, { useState } from 'react';
import { McpCard } from '@core/features/mcp/browser/components/McpCard';
import { McpDrawer, type McpDrawerMode } from '@core/features/mcp/browser/components/McpDrawer';
import type { UseMcpsResult } from '@core/features/mcp/browser/components/useMcps';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { McpConnectSheet } from './McpConnectSheet';

type McpServersListProps = {
  mcp: UseMcpsResult;
  host: HostRef;
  search?: string;
  drawerMode: McpDrawerMode | null;
  onDrawerModeChange: (mode: McpDrawerMode | null) => void;
};

export const McpServersList: React.FC<McpServersListProps> = ({
  mcp,
  host,
  search = '',
  drawerMode,
  onDrawerModeChange,
}) => {
  const [connection, setConnection] = useState<{ entry: McpCatalogEntry; existing?: McpServer }>();
  const openConfirm = useOpenModal('confirmActionModal');

  const handleRemoveRequest = (serverName: string) => {
    onDrawerModeChange(null);
    void openConfirm({
      title: 'Entegrasyon kaldırılsın mı?',
      description: `"${serverName}" bağlantısı tüm ajanlardan kaldırılacak.`,
      confirmLabel: 'Kaldır',
    }).then((outcome) => {
      if (outcome.success) void mcp.removeServer(serverName);
    });
  };

  const drawerSource =
    drawerMode?.type === 'add-catalog'
      ? 'catalog'
      : drawerMode?.type === 'add-custom'
        ? 'custom'
        : null;

  const lowerSearch = search.toLowerCase();
  const installedNames = new Set(mcp.installed.map((server) => server.name));
  const filteredInstalled = mcp.installed.filter(
    (server) => !search || server.name.toLowerCase().includes(lowerSearch)
  );
  const filteredCatalog = mcp.catalog.filter(
    (entry) =>
      !installedNames.has(entry.key) &&
      (!search ||
        entry.name.toLowerCase().includes(lowerSearch) ||
        entry.description.toLowerCase().includes(lowerSearch))
  );

  if (mcp.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center text-foreground">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col text-foreground">
      {connection && (
        <McpConnectSheet
          host={host}
          entry={connection.entry}
          existing={connection.existing}
          providers={mcp.providers}
          onClose={() => setConnection(undefined)}
          onAdvanced={() => {
            onDrawerModeChange(
              connection.existing
                ? { type: 'edit', server: connection.existing }
                : { type: 'add-catalog', entry: connection.entry }
            );
            setConnection(undefined);
          }}
        />
      )}
      <McpDrawer
        open={drawerMode !== null}
        mode={drawerMode}
        host={host}
        providers={mcp.providers}
        onOpenChange={(open) => {
          if (!open) onDrawerModeChange(null);
        }}
        onSave={(server) => mcp.saveServer(server, drawerSource)}
        onRemove={handleRemoveRequest}
      />
      <div className="flex flex-col gap-8 pt-3 pb-8">
        {filteredInstalled.length > 0 && (
          <CardGridSection title="Ajanlara eklenen bağlantılar">
            {filteredInstalled.map((server) => (
              <McpCard
                key={server.name}
                server={server}
                providers={mcp.providers}
                catalogEntry={mcp.catalog.find((entry) => entry.key === server.name)}
                onConnect={
                  mcp.catalog.some((entry) => entry.key === server.name)
                    ? () =>
                        setConnection({
                          entry: mcp.catalog.find((entry) => entry.key === server.name)!,
                          existing: server,
                        })
                    : undefined
                }
                onEdit={(nextServer) => onDrawerModeChange({ type: 'edit', server: nextServer })}
              />
            ))}
          </CardGridSection>
        )}

        {filteredCatalog.length > 0 && (
          <CardGridSection title="Eklenebilir servisler">
            {filteredCatalog.map((entry) => (
              <McpCard
                key={entry.key}
                providers={mcp.providers}
                catalogEntry={entry}
                onConnect={() => setConnection({ entry })}
                onAdd={(nextEntry) => onDrawerModeChange({ type: 'add-catalog', entry: nextEntry })}
              />
            ))}
          </CardGridSection>
        )}

        {filteredInstalled.length === 0 && filteredCatalog.length === 0 && (
          <div className="py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {search ? 'Aramanıza uygun servis bulunamadı.' : 'Kullanılabilir servis bulunamadı.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
