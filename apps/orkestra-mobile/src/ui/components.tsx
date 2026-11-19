import type { ReactNode } from 'react';
import type { AppSession } from '@/core/app-session';
import { describeStatus, type ConnectionStatus } from '@/core/connection-state';

export function Header(props: { title: string; subtitle?: string; onBack?: () => void }) {
  return (
    <header className="header">
      {props.onBack ? (
        <button className="icon-button" onClick={props.onBack} aria-label="Geri">
          ‹
        </button>
      ) : null}
      <div className="header-text">
        <h1>{props.title}</h1>
        {props.subtitle ? <p>{props.subtitle}</p> : null}
      </div>
    </header>
  );
}

export function ConnectionBanner(props: { status: ConnectionStatus; session: AppSession }) {
  const { status } = props;
  if (status.kind === 'connected') return null;
  const failed = status.kind === 'failed';
  return (
    <div className={`banner ${failed ? 'banner-error' : 'banner-warn'}`} role="status">
      <span>{describeStatus(status)}</span>
      {failed && status.reason === 'auth' ? (
        <button className="button small" onClick={() => void props.session.unpair()}>
          Eşleşmeyi kaldır
        </button>
      ) : null}
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}

export function ErrorNote(props: { message: string | null }) {
  return props.message ? (
    <p className="error-note" role="alert">
      {props.message}
    </p>
  ) : null;
}

export function Loading() {
  return <p className="empty">Yükleniyor…</p>;
}

export function ListButton(props: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className="list-item" onClick={props.onClick} disabled={props.disabled}>
      <span className="list-text">
        <span className="list-title">{props.title}</span>
        {props.subtitle ? <span className="list-subtitle">{props.subtitle}</span> : null}
      </span>
      {props.trailing ? <span className="list-trailing">{props.trailing}</span> : null}
    </button>
  );
}

export function TabBar(props: {
  active: 'projects' | 'accounts' | 'settings';
  onSelect: (tab: 'projects' | 'accounts' | 'settings') => void;
}) {
  const tabs = [
    ['projects', 'Projeler'],
    ['accounts', 'Hesaplar'],
    ['settings', 'Ayarlar'],
  ] as const;
  return (
    <nav className="tabbar">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          className={props.active === id ? 'tab active' : 'tab'}
          onClick={() => props.onSelect(id)}
        >
          {label}
        </button>
      ))}
    </nav>
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
