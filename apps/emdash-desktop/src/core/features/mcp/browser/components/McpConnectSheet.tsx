import type { HostRef } from '@emdash/core/primitives/host/api';
import type {
  McpCatalogEntry,
  McpProvidersResponse,
  McpServer,
} from '@emdash/core/primitives/mcp/api';
import { Button, Sheet } from '@emdash/ui/react/primitives';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getMcpClient } from '../../api/browser/client';
import type { McpConnectionState } from '../../api/connection';

export function connectionServer(entry: McpCatalogEntry, providers: string[]): McpServer {
  const config = entry.defaultConfig;
  return {
    name: entry.key.replace(/[^\w.-]/g, '_'),
    transport: entry.key.startsWith('google_') ? 'stdio' : 'http',
    url: typeof config.url === 'string' ? config.url : undefined,
    providers,
    ...(config.oauth === false ? { oauth: false as const } : {}),
  };
}
export function McpConnectSheet({
  host,
  entry,
  existing,
  providers,
  onClose,
  onAdvanced,
}: {
  host: HostRef;
  entry: McpCatalogEntry;
  existing?: McpServer;
  providers: McpProvidersResponse[];
  onClose: () => void;
  onAdvanced: () => void;
}) {
  const [state, setState] = useState<McpConnectionState>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let id: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const selected = existing?.providers.length
      ? existing.providers
      : providers.filter((provider) => provider.installed).map((provider) => provider.id);
    const start = async () => {
      setState(undefined);
      if (
        !entry.key.startsWith('google_') &&
        (entry.credentialKeys.some((key) => key.required) ||
          typeof entry.defaultConfig.url !== 'string')
      ) {
        setState({
          id: '',
          phase: 'failed',
          message:
            'Bu servis tek tıkla hesap girişini desteklemiyor. Servisin erişim bilgileri gerekiyor; gelişmiş ayarlardan bağlayabilirsiniz.',
        });
        return;
      }
      try {
        const client = await getMcpClient();
        const started = await client.connect({ host, server: connectionServer(entry, selected) });
        if (!started.success) {
          if (!disposed)
            setState({
              id: '',
              phase: 'failed',
              message:
                'message' in started.error ? started.error.message : 'Hesap girişi başlatılamadı.',
            });
          return;
        }
        id = started.data.id;
        if (disposed) {
          await client.cancelConnection({ id });
          return;
        }
        setState(started.data);
        const refresh = async () => {
          try {
            const next = await client.connectionStatus({ id: id! });
            if (disposed) return;
            setState(next);
            if (!['connected', 'failed', 'cancelled'].includes(next.phase))
              timer = setTimeout(() => void refresh(), 1000);
          } catch {
            if (!disposed)
              setState({
                id: id!,
                phase: 'failed',
                message: 'Bağlantı durumu alınamadı. Yeniden deneyin.',
              });
          }
        };
        void refresh();
      } catch {
        if (!disposed)
          setState({
            id: id ?? '',
            phase: 'failed',
            message: 'Hesap girişi başlatılamadı. Yeniden deneyin.',
          });
      }
    };
    void start();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (id)
        void getMcpClient()
          .then((client) => client.cancelConnection({ id: id! }))
          .catch(() => {});
    };
  }, [host, entry, existing, providers, attempt]);
  const pending = !state || ['starting', 'awaiting-authorization', 'saving'].includes(state.phase);
  return (
    <Sheet.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Sheet.Content side="right">
        <Sheet.Header>
          <Sheet.Title>{entry.name} hesabını bağla</Sheet.Title>
        </Sheet.Header>
        <div className="flex flex-1 flex-col gap-5 px-4">
          <p className="text-sm text-foreground-muted">{entry.description}</p>
          <div className="flex items-center gap-3">
            {pending ? (
              <Loader2 className="size-5 shrink-0 animate-spin" />
            ) : state.phase === 'connected' ? (
              <CheckCircle2 className="size-5 shrink-0 text-green-500" />
            ) : null}
            <p role="status" className="text-sm">
              {state?.message ?? 'Hesap giriş sayfası hazırlanıyor…'}
            </p>
          </div>
          {state?.url && pending && (
            <Button onClick={() => window.open(state.url, '_blank', 'noopener,noreferrer')}>
              Giriş sayfasını aç
            </Button>
          )}
          {state?.phase === 'failed' && (
            <Button onClick={() => setAttempt((value) => value + 1)}>Yeniden bağla</Button>
          )}
          <p className="text-xs text-foreground-muted">
            Giriş tamamlanınca bağlantı seçilen makinedeki{' '}
            {existing?.providers.length ? 'mevcut' : 'kurulu'} ajanlara eklenir. Kullanılabilmesi
            için yeni bir ajan sohbeti açın.
          </p>
          <Button variant="ghost" onClick={onAdvanced}>
            Gelişmiş ayarlar
          </Button>
        </div>
        <Sheet.Footer>
          <Button onClick={onClose}>{state?.phase === 'connected' ? 'Tamam' : 'Kapat'}</Button>
        </Sheet.Footer>
      </Sheet.Content>
    </Sheet.Root>
  );
}
