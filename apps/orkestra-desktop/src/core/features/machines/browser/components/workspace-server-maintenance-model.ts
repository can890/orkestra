import type { PillVariant } from '@orkestra/ui/react/components';
import type {
  HostMaintenanceState,
  HostMaintenanceStatus,
  ServerActivity,
  ServerActivityKind,
  ServerVersionRole,
} from '@core/services/hosts/api/maintenance-contract';

/** Bakım kartının saf görünüm yardımcıları; bileşenden ayrı tutulur ki node testleriyle sınansın. */

const statusViews: Record<
  HostMaintenanceStatus,
  { label: string; variant: PillVariant; pulsing?: boolean }
> = {
  unknown: { label: 'Bilinmiyor', variant: 'neutral' },
  checking: { label: 'Denetleniyor', variant: 'info', pulsing: true },
  'up-to-date': { label: 'Güncel', variant: 'success' },
  'update-available': { label: 'Güncelleme var', variant: 'warning' },
  'waiting-for-idle': { label: 'Boşta olmasını bekliyor', variant: 'warning' },
  updating: { label: 'Güncelleniyor', variant: 'info', pulsing: true },
  'dev-build': { label: 'Geliştirme sürümü', variant: 'neutral' },
  failed: { label: 'Hata', variant: 'error' },
};

export function maintenanceStatusView(status: HostMaintenanceStatus) {
  return statusViews[status];
}

/** Güncelle düğmesi yalnızca kanalda yeni bir sürüm bilindiğinde ve iş sürmüyorken etkin. */
export function canUpdateNow(state: HostMaintenanceState | undefined): boolean {
  if (!state?.availableVersion || !state.runningVersion) return false;
  if (state.status === 'updating' || state.status === 'checking') return false;
  return state.availableVersion !== state.runningVersion;
}

const activityKindLabels: Record<ServerActivityKind, string> = {
  'agent-turn': 'Ajan turu',
  'agent-session': 'TUI ajan oturumu',
  terminal: 'Terminal',
  script: 'Betik',
  'dev-server': 'Geliştirme sunucusu',
};

export function activityKindLabel(kind: ServerActivityKind): string {
  return activityKindLabels[kind];
}

/** Meşgul sunucuda güncelleme öncesi kesilecek işlerin listesi; boştaysa null. */
export function interruptionSummary(activity: ServerActivity): {
  items: string[];
  incomplete: boolean;
} | null {
  if (activity.complete && activity.items.length === 0) return null;
  return {
    items: activity.items.map((item) => `${activityKindLabel(item.kind)}: ${item.label}`),
    incomplete: !activity.complete,
  };
}

const roleLabels: Record<ServerVersionRole, string> = {
  current: 'Etkin',
  running: 'Çalışan',
  previous: 'Önceki',
  prunable: 'Temizlenebilir',
  kept: 'Korunuyor',
  unrecognized: 'Tanınmayan',
};

export function versionRoleLabel(role: ServerVersionRole): string {
  return roleLabels[role];
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatUptime(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return '—';
  const totalMinutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} gün ${hours} sa`;
  if (hours > 0) return `${hours} sa ${minutes} dk`;
  return `${minutes} dk`;
}

export function formatRelativeTime(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return 'Henüz denetlenmedi';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'az önce';
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.floor(hours / 24)} gün önce`;
}
