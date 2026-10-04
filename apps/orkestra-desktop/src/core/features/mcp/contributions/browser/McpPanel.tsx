import type { HostRef } from '@orkestra/core/primitives/host/api';
import { PageLayout } from '@orkestra/ui/react/patterns';
import { Button } from '@orkestra/ui/react/primitives';
import React, { useState } from 'react';
import type { McpDrawerMode } from '@core/features/mcp/browser/components/McpDrawer';
import { McpServersList } from '@core/features/mcp/browser/components/McpServersList';
import { McpToolbar } from '@core/features/mcp/browser/components/McpToolbar';
import { useMcps } from '@core/features/mcp/browser/components/useMcps';

type McpPanelProps = {
  host: HostRef;
  applicationCatalog?: boolean;
  header?: { title: string; description: string };
};

export function McpPanel({ host, header, applicationCatalog = false }: McpPanelProps) {
  const [registrySearch, setRegistrySearch] = useState<string>();
  const mcp = useMcps(host, registrySearch);
  const [search, setSearch] = useState('');
  const [drawerMode, setDrawerMode] = useState<McpDrawerMode | null>(null);

  const toolbar = (
    <McpToolbar
      search={search}
      onSearchChange={setSearch}
      onRefresh={mcp.refresh}
      isRefreshing={mcp.isRefreshing}
      onAddCustom={() => setDrawerMode({ type: 'add-custom' })}
    />
  );

  return (
    <div className="flex flex-col text-foreground">
      {header ? (
        <PageLayout.Header
          sticky
          title={header.title}
          description={header.description}
          actions={toolbar}
        />
      ) : (
        toolbar
      )}
      {applicationCatalog && (
        <div className="my-3 space-y-2">
          <Button
            variant="secondary"
            disabled={search.trim().length < 2 || mcp.isSearchingCatalog}
            onClick={() => setRegistrySearch(search.trim())}
          >
            {mcp.isSearchingCatalog ? 'Katalog aranıyor…' : 'Tüm MCP kataloğunda ara'}
          </Button>
          {registrySearch !== undefined && (
            <Button variant="secondary" onClick={() => setRegistrySearch(undefined)}>
              Hazır servisleri göster
            </Button>
          )}
          <p className="text-xs text-foreground-muted">
            Hazır bağlantılarda bulamadığınız servisleri adıyla MCP kataloğunda arayın. Katalog,
            servis sağlayıcıların ve topluluk geliştiricilerinin bağlantılarını içerir.
          </p>
          {mcp.catalogError && (
            <p role="alert" className="text-sm text-foreground-error">
              Katalog yüklenemedi. Bağlantınızı kontrol edip yeniden deneyin.
            </p>
          )}
        </div>
      )}
      <McpServersList
        mcp={mcp}
        host={host}
        search={search}
        drawerMode={drawerMode}
        onDrawerModeChange={setDrawerMode}
      />
    </div>
  );
}
