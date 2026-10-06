import { Pill } from '@orkestra/ui/react/components';
import { SettingsCard, SettingsRow } from '@orkestra/ui/react/patterns';
import { Button, SeparatedList } from '@orkestra/ui/react/primitives';
import { DownloadIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { HostMaintenanceState } from '@core/services/hosts/api/maintenance-contract';
import type { HostMaintenanceActions } from '../use-host-maintenance';
import {
  canUpdateNow,
  formatBytes,
  formatRelativeTime,
  formatUptime,
  interruptionSummary,
  maintenanceStatusView,
  versionRoleLabel,
} from './workspace-server-maintenance-model';

export type MaintenanceConfirm = (args: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  variant?: 'destructive' | 'default';
}) => Promise<boolean>;

/**
 * Uzak workspace-server bakım kartı: sürüm ve güncelleme durumu, "Güncelle"/"Denetle"
 * eylemleri, çalışma süresi, disk kullanımı ve eski sürümlerin temizlenmesi.
 */
export function WorkspaceServerMaintenanceCard({
  state,
  serverStartedAt,
  actions,
  confirm,
  now = Date.now(),
}: {
  state: HostMaintenanceState | undefined;
  serverStartedAt?: number;
  actions: HostMaintenanceActions;
  confirm: MaintenanceConfirm;
  now?: number;
}) {
  const [busyAction, setBusyAction] = useState<'check' | 'update' | 'prune' | undefined>();
  const status = maintenanceStatusView(state?.status ?? 'unknown');
  const health = state?.health;
  const prunable = health?.versions.filter((entry) => entry.role === 'prunable') ?? [];

  const runAction = async (action: 'check' | 'update' | 'prune', work: () => Promise<void>) => {
    setBusyAction(action);
    try {
      await work();
    } finally {
      setBusyAction(undefined);
    }
  };

  const requestUpdate = () =>
    runAction('update', async () => {
      const activity = await actions.inspectActivity();
      if (!activity) return;
      const summary = interruptionSummary(activity);
      if (summary) {
        const accepted = await confirm({
          title: 'Sunucu meşgul — yine de güncellensin mi?',
          description: (
            <div className="flex flex-col gap-2 text-sm">
              <p>Güncelleme workspace sunucusunu yeniden başlatır. Şu işler kesilecek:</p>
              {summary.items.length > 0 && (
                <ul className="list-disc pl-5" data-testid="interruption-list">
                  {summary.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {summary.incomplete && (
                <p className="text-foreground-muted">
                  Bazı çalışma zamanları okunamadı; liste eksik olabilir.
                </p>
              )}
            </div>
          ),
          confirmLabel: 'Güncelle ve yeniden başlat',
          variant: 'destructive',
        });
        if (!accepted) return;
      }
      await actions.updateNow();
    });

  const requestPrune = () =>
    runAction('prune', async () => {
      const accepted = await confirm({
        title: 'Eski sürümler temizlensin mi?',
        description: `${prunable.length} eski sürüm silinecek (${formatBytes(
          health?.prunableBytes
        )}). Etkin, çalışan ve önceki sürüm korunur.`,
        confirmLabel: 'Temizle',
        variant: 'destructive',
      });
      if (accepted) await actions.prune();
    });

  return (
    <SettingsCard>
      <SeparatedList gap="1rem" direction="column">
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              Sunucu sürümü
              <Pill
                variant={status.variant}
                pulsing={status.pulsing}
                data-testid="maintenance-status"
              >
                {status.label}
              </Pill>
            </span>
          }
          description={
            <span className="flex flex-col gap-1">
              <span className="tabular-nums">
                Çalışan: {state?.runningVersion ? `v${state.runningVersion}` : '—'} · Kanal:{' '}
                {state?.availableVersion ? `v${state.availableVersion}` : '—'}
              </span>
              <span>Son denetim: {formatRelativeTime(state?.lastCheckedAt, now)}</span>
              {state?.status === 'waiting-for-idle' && (
                <span>
                  Sunucu boşa çıkınca otomatik güncellenecek; şimdi güncellemek için Güncelle'ye
                  basın.
                </span>
              )}
              {state?.lastUpdate && (
                <span>
                  {state.lastUpdate.automatic ? 'Otomatik güncellendi' : 'Güncellendi'}: v
                  {state.lastUpdate.to} ({formatRelativeTime(state.lastUpdate.at, now)})
                </span>
              )}
              {state?.error && <span className="text-destructive">{state.error}</span>}
            </span>
          }
          control={
            <span className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="xs"
                disabled={busyAction !== undefined || state?.status === 'checking'}
                onClick={() => void runAction('check', actions.check)}
              >
                <RefreshCwIcon />
                Denetle
              </Button>
              <Button
                type="button"
                variant="primary"
                size="xs"
                disabled={busyAction !== undefined || !canUpdateNow(state)}
                onClick={() => void requestUpdate()}
              >
                <DownloadIcon />
                Güncelle
              </Button>
            </span>
          }
        />
        <SettingsRow
          label="Sunucu sağlığı"
          description={
            <span className="flex flex-col gap-1">
              <span>
                Çalışma süresi: {formatUptime(serverStartedAt ?? state?.daemonStartedAt, now)}
              </span>
              <span>
                Disk kullanımı: {formatBytes(health?.rootBytes)}
                {health?.freeBytes !== undefined && ` · Boş alan: ${formatBytes(health.freeBytes)}`}
              </span>
              {health && health.versions.length > 0 && (
                <span className="flex flex-wrap gap-x-3 gap-y-1" data-testid="version-list">
                  {health.versions.map((entry) => (
                    <span key={entry.name} className="tabular-nums">
                      v{entry.name} · {versionRoleLabel(entry.role)} · {formatBytes(entry.bytes)}
                    </span>
                  ))}
                </span>
              )}
              {health?.pruneBlockedReason && (
                <span className="text-destructive">{health.pruneBlockedReason}</span>
              )}
              {state?.healthError && <span className="text-destructive">{state.healthError}</span>}
            </span>
          }
          control={
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={
                busyAction !== undefined || state?.pruning === true || prunable.length === 0
              }
              onClick={() => void requestPrune()}
            >
              <Trash2Icon />
              Eski sürümleri temizle
            </Button>
          }
        />
      </SeparatedList>
    </SettingsCard>
  );
}
