import { CollectionToolbar } from '@emdash/ui/react/patterns';
import { Button } from '@emdash/ui/react/primitives';
import { Plus, RefreshCw } from 'lucide-react';
import React from 'react';
import { useSearchFocusHotkeys } from '@core/primitives/keybindings/browser';

type McpToolbarProps = {
  search: string;
  onSearchChange: (search: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onAddCustom: () => void;
};

export function McpToolbar({
  search,
  onSearchChange,
  onRefresh,
  isRefreshing,
  onAddCustom,
}: McpToolbarProps) {
  const searchRef = useSearchFocusHotkeys();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        ref={searchRef}
        value={search}
        onValueChange={onSearchChange}
        placeholder="Servis adıyla arayın…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        <Button
          variant="secondary"
          icon
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label="Bağlantıları yenile"
        >
          <RefreshCw
            className={`text-muted-foreground h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
          />
        </Button>
        <Button variant="primary" onClick={onAddCustom}>
          <Plus className="size-4" />
          Özel bağlantı ekle
        </Button>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
}
