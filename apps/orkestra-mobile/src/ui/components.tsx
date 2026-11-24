import type { ReactNode } from 'react';
import sovraIcon from '@/assets/sovra-icon.png';
import type { AppSession } from '@/core/app-session';
import { describeStatus, type ConnectionStatus } from '@/core/connection-state';
import type { TaskStatus } from '@/core/mappers';
import { ChevronDownIcon, ChevronLeftIcon, PanelLeftIcon, ShieldAlertIcon } from './icons';

export function SovraMark(props: { size?: number }) {
  const size = props.size ?? 24;
  return (
    <img
      src={sovraIcon}
      alt="Sovra"
      width={size}
      height={size}
      className="brand-mark"
      draggable={false}
    />
  );
}

export function WorkbenchHeader(props: {
  title: string;
  subtitle?: string;
  brandMark?: boolean;
  onMenu?: () => void;
  onBack?: () => void;
  trailing?: ReactNode;
  badgeCount?: number;
}) {
  return (
    <header className="wb-header">
      <div className="wb-header-left">
        {props.onMenu ? (
          <button
            type="button"
            className="wb-icon-btn"
            onClick={props.onMenu}
            aria-label="Kenar çubuğunu aç"
          >
            <PanelLeftIcon size={19} />
            {props.badgeCount && props.badgeCount > 0 ? (
              <span className="wb-icon-badge" aria-hidden="true">
                {props.badgeCount > 9 ? '9+' : props.badgeCount}
              </span>
            ) : null}
          </button>
        ) : null}
        {props.onBack ? (
          <button type="button" className="wb-icon-btn" onClick={props.onBack} aria-label="Geri">
            <ChevronLeftIcon size={20} />
          </button>
        ) : null}
        {props.brandMark ? <SovraMark size={24} /> : null}
        <div className="wb-header-titles">
          <h1 className="wb-title">{props.title}</h1>
          {props.subtitle ? <p className="wb-subtitle">{props.subtitle}</p> : null}
        </div>
      </div>
      {props.trailing ? <div className="wb-header-right">{props.trailing}</div> : null}
    </header>
  );
}

export function ConnectionPill(props: {
  status: ConnectionStatus;
  hostName?: string;
  onClick?: () => void;
  showChevron?: boolean;
}) {
  const connected = props.status.kind === 'connected';
  const failed = props.status.kind === 'failed';
  const cleanHost = props.hostName?.replace(/\.local$/i, '');
  const label = connected ? cleanHost || 'Bağlı' : failed ? 'Bağlantı yok' : 'Bağlanıyor…';
  const cls = `conn-pill ${connected ? 'is-ok' : failed ? 'is-err' : 'is-warn'}${
    props.onClick ? ' is-clickable' : ''
  }`;
  if (props.onClick) {
    return (
      <button
        type="button"
        className={cls}
        title={describeStatus(props.status)}
        onClick={props.onClick}
      >
        <span className="conn-pill-dot" aria-hidden="true" />
        <span className="conn-pill-text">{label}</span>
        {props.showChevron ? <ChevronDownIcon size={12} className="conn-pill-caret" /> : null}
      </button>
    );
  }
  return (
    <span className={cls} title={describeStatus(props.status)}>
      <span className="conn-pill-dot" aria-hidden="true" />
      <span className="conn-pill-text">{label}</span>
    </span>
  );
}

export function GlobalPermissionBanner(props: {
  count: number;
  title: string;
  onOpen: () => void;
}) {
  if (props.count <= 0) return null;
  return (
    <button type="button" className="global-perm-banner" onClick={props.onOpen} role="alert">
      <span className="global-perm-icon" aria-hidden="true">
        <ShieldAlertIcon size={15} />
      </span>
      <span className="global-perm-text">
        <strong>{props.title}</strong>
        <span>
          {props.count > 1 ? ` · +${props.count - 1} onay daha bekliyor` : ' · İzin onayı bekliyor'}
        </span>
      </span>
      <span className="global-perm-cta">Aç</span>
    </button>
  );
}

export function ConnectionBanner(props: { status: ConnectionStatus; session: AppSession }) {
  const { status } = props;
  if (status.kind === 'connected') return null;
  const failed = status.kind === 'failed';
  return (
    <div className={`banner ${failed ? 'banner-error' : 'banner-warn'}`} role="status">
      <span className="banner-text">{describeStatus(status)}</span>
      {failed && status.reason === 'auth' ? (
        <button type="button" className="btn btn-sm" onClick={() => void props.session.unpair()}>
          Eşleşmeyi kaldır
        </button>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => props.session.refresh()}>
          Yenile
        </button>
      )}
    </div>
  );
}

export function TaskStatusDot(props: { status: TaskStatus; working?: boolean }) {
  if (props.working) {
    return <span className="status-dot is-working" title="Ajan çalışıyor" aria-hidden="true" />;
  }
  return <span className={`status-dot is-${props.status}`} aria-hidden="true" />;
}

export function ProviderPill(props: { providerId: string; names?: Record<string, string> }) {
  const label = providerDisplayName(props.providerId, props.names);
  return <span className="provider-pill">{label}</span>;
}

export function providerDisplayName(providerId: string, names?: Record<string, string>): string {
  if (names && names[providerId]) return names[providerId]!;
  switch (providerId.toLowerCase()) {
    case 'claude':
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'antigravity':
      return 'Antigravity';
    case 'gemini':
      return 'Gemini';
    case 'kimi':
      return 'Kimi';
    case 'grok':
      return 'Grok';
    case 'glm':
      return 'GLM';
    case 'opencode':
      return 'OpenCode';
    case 'cursor':
      return 'Cursor';
    default:
      return providerId || 'Ajan';
  }
}

export function Empty(props: { icon?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      {props.icon ? <div className="empty-icon">{props.icon}</div> : null}
      {props.title ? <p className="empty-title">{props.title}</p> : null}
      <p className="empty-desc">{props.children}</p>
    </div>
  );
}

export function ErrorNote(props: { message: string | null }) {
  return props.message ? (
    <div className="error-note" role="alert">
      {props.message}
    </div>
  ) : null;
}

export function Loading(props: { label?: string }) {
  return (
    <div className="loading-row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{props.label ?? 'Yükleniyor…'}</span>
    </div>
  );
}

/** ISO zamanı kısa, yerel biçimde ("19 Kas 10:30"). Geçersizse boş döner. */
export function shortTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('tr-TR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Göreli zaman: "az önce", "4 dk", "2 sa", "19 Kas". */
export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 60) return 'şimdi';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} dk`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} sa`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} gün`;
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}
