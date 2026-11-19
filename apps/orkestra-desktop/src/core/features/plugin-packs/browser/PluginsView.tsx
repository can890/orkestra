import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { PageLayout } from '@orkestra/ui/react/patterns';
import { Button, Input, Spinner, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useAgentInstallationStatuses } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import type { PluginPreview } from '../api/schemas';
import { getPluginPacksClient } from './client';

const STATE_KEY = ['plugin-packs', 'state'] as const;

function unwrap<T>(
  result: { success: true; data: T } | { success: false; error: { message: string } }
): T {
  if (result.success) return result.data;
  throw new Error(result.error.message);
}

export function PluginsView() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const { data: agentStatuses } = useAgentInstallationStatuses(LOCAL_HOST_REF);
  const providers = useMemo(
    () => (agentStatuses ?? []).filter((s) => s.status === 'available').map((s) => s.id),
    [agentStatuses]
  );

  const state = useQuery({
    queryKey: STATE_KEY,
    queryFn: async () => unwrap(await (await getPluginPacksClient()).state(undefined)),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plugin-packs'] });
  const onError = (error: Error) => toast.error('İşlem başarısız', { description: error.message });

  const addMarketplace = useMutation({
    mutationFn: async () => unwrap(await (await getPluginPacksClient()).addMarketplace({ source })),
    onSuccess: () => {
      setSource('');
      void refresh();
    },
    onError,
  });
  const removeMarketplace = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await (await getPluginPacksClient()).removeMarketplace({ id })),
    onSuccess: () => void refresh(),
    onError,
  });
  const previewPlugin = useMutation({
    mutationFn: async (input: { marketplaceId: string; plugin: string }) =>
      unwrap(
        await (await getPluginPacksClient()).previewPlugin({ host: LOCAL_HOST_REF, ...input })
      ),
    onSuccess: setPreview,
    onError,
  });
  const installPlugin = useMutation({
    mutationFn: async (p: PluginPreview) =>
      unwrap(
        await (
          await getPluginPacksClient()
        ).installPlugin({
          host: LOCAL_HOST_REF,
          marketplaceId: p.marketplaceId,
          plugin: p.plugin,
          digest: p.digest,
          providers,
        })
      ),
    onSuccess: (_, p) => {
      toast.success(`${p.plugin} kuruldu`);
      setPreview(null);
      void refresh();
    },
    onError,
  });
  const uninstallPlugin = useMutation({
    mutationFn: async (input: { marketplaceId: string; plugin: string }) =>
      unwrap(
        await (await getPluginPacksClient()).uninstallPlugin({ host: LOCAL_HOST_REF, ...input })
      ),
    onSuccess: (result) => {
      toast.success('Eklenti kaldırıldı', {
        description: result.kept.length
          ? `Korunanlar: ${result.kept.join(', ')}`
          : `${result.removed.length} öğe silindi`,
      });
      void refresh();
    },
    onError,
  });

  const marketplaces = state.data?.marketplaces ?? [];

  return (
    <div className="flex flex-col text-foreground">
      <PageLayout.Header
        sticky
        title="Eklentiler"
        description="Claude Code biçimindeki eklenti paketlerini marketplace'ten kurun"
      />
      <div className="flex flex-col gap-6 p-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (source.trim()) addMarketplace.mutate();
          }}
        >
          <Input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="owner/repo ya da https://… git adresi"
            aria-label="Marketplace kaynağı"
          />
          <Button
            variant="primary"
            type="submit"
            disabled={addMarketplace.isPending || !source.trim()}
          >
            {addMarketplace.isPending ? <Spinner size="sm" /> : null}
            Marketplace ekle
          </Button>
        </form>
        <p className="text-xs text-foreground-muted">
          Yalnızca https git adresleri kabul edilir. Depo sığ klonlanır; eklentideki hiçbir script
          ya da hook çalıştırılmaz. Kurmadan önce eklenecekler gösterilir.
        </p>

        {state.isLoading ? <Spinner size="sm" /> : null}
        {marketplaces.map((marketplace) => (
          <MarketplaceSection
            key={marketplace.id}
            marketplace={marketplace}
            installs={state.data?.installs ?? []}
            onRemove={() => removeMarketplace.mutate(marketplace.id)}
            onPreview={(plugin) => previewPlugin.mutate({ marketplaceId: marketplace.id, plugin })}
            onUninstall={(plugin) =>
              uninstallPlugin.mutate({ marketplaceId: marketplace.id, plugin })
            }
          />
        ))}
        {!state.isLoading && marketplaces.length === 0 ? (
          <p className="text-sm text-foreground-muted">Henüz marketplace eklenmedi.</p>
        ) : null}

        {preview ? (
          <PreviewPanel
            preview={preview}
            providers={providers}
            installing={installPlugin.isPending}
            onCancel={() => setPreview(null)}
            onInstall={() => installPlugin.mutate(preview)}
          />
        ) : null}
      </div>
    </div>
  );
}

type Installs = { marketplaceId: string; plugin: string }[];

function MarketplaceSection(props: {
  marketplace: { id: string; name: string; label: string };
  installs: Installs;
  onRemove: () => void;
  onPreview: (plugin: string) => void;
  onUninstall: (plugin: string) => void;
}) {
  const { marketplace, installs } = props;
  const plugins = useQuery({
    queryKey: ['plugin-packs', 'plugins', marketplace.id, installs.length],
    queryFn: async () =>
      unwrap(await (await getPluginPacksClient()).listPlugins({ marketplaceId: marketplace.id })),
  });
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <h3 className="text-md">{marketplace.name}</h3>
          <span className="text-xs text-foreground-muted">{marketplace.label}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={props.onRemove}>
          Marketplace'i kaldır
        </Button>
      </div>
      {plugins.isLoading ? <Spinner size="sm" /> : null}
      {plugins.error ? (
        <p className="text-destructive text-xs">{(plugins.error as Error).message}</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {(plugins.data?.plugins ?? []).map((plugin) => (
          <li
            key={plugin.name}
            className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm">
                {plugin.name}
                {plugin.version ? ` · ${plugin.version}` : ''}
              </span>
              <span className="line-clamp-1 text-xs text-foreground-muted">
                {plugin.unavailableReason ?? plugin.description ?? ''}
              </span>
            </div>
            {plugin.installed ? (
              <Button size="sm" variant="secondary" onClick={() => props.onUninstall(plugin.name)}>
                Kaldır
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={Boolean(plugin.unavailableReason)}
                onClick={() => props.onPreview(plugin.name)}
              >
                İncele ve kur
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PreviewPanel(props: {
  preview: PluginPreview;
  providers: string[];
  installing: boolean;
  onCancel: () => void;
  onInstall: () => void;
}) {
  const { preview } = props;
  const blocked = preview.conflicts.length > 0;
  const needsProvider = preview.mcpServers.length > 0 && props.providers.length === 0;
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h3 className="text-md">
        {preview.plugin}
        {preview.version ? ` · ${preview.version}` : ''} kurulumu
      </h3>
      {preview.description ? (
        <p className="text-sm text-foreground-muted">{preview.description}</p>
      ) : null}

      <Group title={`Skill'ler (${preview.skills.length})`}>
        {preview.skills.map((s) => (
          <li key={s.installId}>
            <b>{s.installId}</b> — {s.description || 'açıklama yok'}
          </li>
        ))}
        {preview.skills.length > 0 ? (
          <li className="text-foreground-muted">
            Yalnızca SKILL.md kaydedilir; skill'in yanındaki script ve dosyalar kopyalanmaz.
          </li>
        ) : null}
      </Group>
      <Group title={`Prompt komutları (${preview.commands.length})`}>
        {preview.commands.map((c) => (
          <li key={c.promptId}>{c.name}</li>
        ))}
      </Group>
      <Group title={`Çalıştırılacak MCP sunucuları (${preview.mcpServers.length})`}>
        {preview.mcpServers.map((server) => (
          <li key={server.name} className="flex flex-col gap-0.5">
            <b>
              {server.name} ({server.transport})
            </b>
            <code className="bg-surface-2 rounded p-1 text-xs break-all">{server.commandLine}</code>
            {server.env ? (
              <code className="text-xs break-all text-foreground-muted">
                env:{' '}
                {Object.entries(server.env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' ')}
              </code>
            ) : null}
            {server.headers ? (
              <code className="text-xs break-all text-foreground-muted">
                başlıklar: {Object.keys(server.headers).join(', ')}
              </code>
            ) : null}
          </li>
        ))}
        {preview.mcpServers.length > 0 ? (
          <li className="text-warning">
            Bu komutlar onayınızla ajanlarınızın oturumlarında bilgisayarınızda çalışacaktır.
            Yalnızca güvendiğiniz eklentileri kurun.
          </li>
        ) : null}
      </Group>
      <Group title={`Desteklenmeyenler (${preview.unsupported.length})`}>
        {preview.unsupported.map((u, index) => (
          <li key={`${u.kind}-${u.label}-${index}`} className="text-foreground-muted">
            {u.kind === 'hook' ? 'Hook' : u.kind === 'agent' ? 'Alt ajan' : u.kind}: {u.label}
            {u.detail ? ` — ${u.detail}` : ''}
          </li>
        ))}
      </Group>
      {blocked ? (
        <p className="text-destructive text-sm">
          Kurulum engellendi, mevcut kayıtlarla çakışma var: {preview.conflicts.join(', ')}
        </p>
      ) : null}
      {needsProvider ? (
        <p className="text-destructive text-sm">MCP için kurulu bir ajan bulunamadı.</p>
      ) : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={blocked || needsProvider || props.installing}
          onClick={props.onInstall}
        >
          {props.installing ? <Spinner size="sm" /> : null}
          Onayla ve kur
        </Button>
        <Button variant="secondary" onClick={props.onCancel}>
          Vazgeç
        </Button>
      </div>
    </section>
  );
}

function Group(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-foreground-muted uppercase">{props.title}</h4>
      <ul className="flex flex-col gap-1 text-sm">{props.children}</ul>
    </div>
  );
}
