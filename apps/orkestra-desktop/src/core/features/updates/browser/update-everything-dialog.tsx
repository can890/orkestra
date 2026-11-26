/**
 * UpdateEverythingDialog — Unified modal showing Sovra Desktop app update state
 * plus all installed AI Agent CLI statuses & quick check/update actions (Feature #6).
 *
 * Adapted from T3 Code (MIT License) UpdateEverythingDialog.tsx.
 */

import { Badge, Button, Dialog } from '@orkestra/ui/react/primitives';
import { ArrowUpRight, CheckCircle2, Download, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentInstallationStatuses } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';

export const UpdateEverythingDialog = observer(function UpdateEverythingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = getUpdateStore();
  const { navigate } = useNavigate();
  const localHost = useMemo(() => hostRefFromConnectionId(undefined), []);
  const { data: agents = [], refetch: refetchAgents, isFetching: fetchingAgents } = useAgents(localHost);
  const {
    data: installStatuses = [],
    refetch: refetchStatuses,
    isFetching: fetchingStatuses,
    update: updateAgent,
  } = useAgentInstallationStatuses(localHost);
  const [checkingAll, setCheckingAll] = useState(false);

  const statusById = useMemo(
    () => new Map(installStatuses.map((entry) => [entry.id, entry])),
    [installStatuses]
  );

  const handleCheckAll = async () => {
    setCheckingAll(true);
    try {
      await Promise.allSettled([update.check(), refetchAgents(), refetchStatuses()]);
    } finally {
      setCheckingAll(false);
    }
  };

  const isBusy = checkingAll || fetchingAgents || fetchingStatuses || update.state.status === 'checking';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="max-w-lg">
        <Dialog.Header>
          <Dialog.Title className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-foreground-muted" />
            Güncelleme Merkezi
          </Dialog.Title>
          <Dialog.Description>
            Sovra masaüstü uygulaması ve kurulu yapay zeka ajanlarının güncel durumunu tek yerden
            denetleyin.
          </Dialog.Description>
        </Dialog.Header>

        <div className="flex flex-col gap-3 py-2 text-sm">
          {/* Desktop App Card */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-foreground/[0.02] p-3">
            <div className="flex flex-col">
              <span className="font-medium text-foreground">
                Sovra Masaüstü{' '}
                <span className="font-mono text-xs text-foreground-muted">
                  v{update.currentVersion}
                </span>
              </span>
              <span className="text-xs text-foreground-muted">
                {update.state.status === 'available'
                  ? `Yeni sürüm hazır: v${update.availableVersion ?? update.state.info?.version ?? ''}`
                  : update.state.status === 'downloading'
                    ? `İndiriliyor… ${update.progressLabel}`
                    : update.state.status === 'downloaded'
                      ? 'İndirildi — yeniden başlatarak kurabilirsiniz.'
                      : update.state.status === 'checking'
                        ? 'Denetleniyor…'
                        : 'Güncel sürüm kullanılıyor.'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {update.state.status === 'downloaded' ? (
                <Button size="xs" variant="primary" onClick={() => void update.install()}>
                  Yeniden Başlat
                </Button>
              ) : update.state.status === 'available' ? (
                <Button size="xs" variant="primary" onClick={() => void update.runPrimaryAction()}>
                  <Download className="size-3.5" />
                  {update.installMode === 'in-app' ? 'İndir' : 'Sürümü Aç'}
                </Button>
              ) : (
                <Badge variant="soft" tone="success">
                  <CheckCircle2 className="mr-1 size-3" />
                  Güncel
                </Badge>
              )}
            </div>
          </div>

          {/* Installed Agents List */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-foreground-muted">
              <span className="font-medium">Kurulu Ajan CLI Araçları ({agents.length})</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                  navigate(settingsViewDef({ tab: 'clis-models' }));
                }}
              >
                CLI & Modeller
                <ArrowUpRight className="size-3" />
              </Button>
            </div>
            <div className="max-h-56 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
              {agents.map((agent) => {
                const st = statusById.get(agent.id);
                const installed = st?.status === 'available' || Boolean(st?.version);
                const hasNewer = Boolean(st?.updateAvailable);
                return (
                  <div
                    key={agent.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-foreground">{agent.name}</span>
                      <span className="truncate text-[11px] text-foreground-muted">
                        {st?.version
                          ? `v${st.version}${hasNewer && st?.latestVersion ? ` → v${st.latestVersion}` : ''}`
                          : installed
                            ? 'Kurulu'
                            : 'Kurulu değil'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {hasNewer ? (
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => updateAgent({ id: agent.id })}
                        >
                          Güncelle
                        </Button>
                      ) : (
                        <Badge variant="soft" tone={installed ? 'success' : 'neutral'}>
                          {installed ? 'Hazır' : 'Yok'}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
              {agents.length === 0 && (
                <div className="p-3 text-center text-xs text-foreground-muted">
                  Ajan listesi yükleniyor…
                </div>
              )}
            </div>
          </div>
        </div>

        <Dialog.Footer>
          <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => void handleCheckAll()}>
            {isBusy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Hepsini Denetle
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Kapat
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
});
