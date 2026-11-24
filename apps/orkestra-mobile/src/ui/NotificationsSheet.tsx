import type { NotificationView } from '@/core/mappers';
import { Empty, relativeTime } from './components';
import { BellIcon, CheckCheckIcon, ChevronRightIcon, XIcon } from './icons';

export function NotificationsSheet(props: {
  open: boolean;
  hostName?: string;
  notifications: NotificationView[];
  onOpenNotification: (item: NotificationView) => void;
  onMarkAllRead: () => void;
  onDismiss: (id: string) => void;
  onClose: () => void;
}) {
  if (!props.open) return null;

  const unreadCount = props.notifications.filter((n) => n.readAt === null).length;

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="Bildirimler">
      <div className="sheet-backdrop" onClick={props.onClose} />
      <div className="sheet-panel">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div className="sheet-title-group">
            <h2 className="sheet-title">Bildirimler</h2>
            <p className="sheet-subtitle">
              {unreadCount > 0
                ? `${unreadCount} okunmamış bildirim`
                : props.notifications.length > 0
                  ? 'Tümü okundu'
                  : 'Masaüstü bildirim akışı'}
            </p>
          </div>
          {unreadCount > 0 ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={props.onMarkAllRead}
              title="Tümünü okundu işaretle"
            >
              <CheckCheckIcon size={14} />
              <span>Okundu say</span>
            </button>
          ) : null}
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={props.onClose}
            aria-label="Kapat"
          >
            <XIcon size={17} />
          </button>
        </div>

        <div className="sheet-body">
          {props.notifications.length === 0 ? (
            <Empty icon={<BellIcon size={30} />} title="Bildirim yok">
              {props.hostName || 'Bilgisayar'} üzerindeki ajanlar bir işi tamamladığında veya onay
              beklediğinde burada görünür.
            </Empty>
          ) : (
            <div className="notif-list">
              {props.notifications.map((item) => {
                const unread = item.readAt === null;
                const navigable = item.target.kind === 'task';
                const iso = item.createdAt > 0 ? new Date(item.createdAt).toISOString() : null;
                return (
                  <div key={item.id} className={`notif-card ${unread ? 'is-unread' : ''}`}>
                    <button
                      type="button"
                      className="notif-card-main"
                      onClick={() => props.onOpenNotification(item)}
                    >
                      <span
                        className={`notif-dot ${unread ? 'is-unread' : ''}`}
                        aria-hidden="true"
                      />
                      <div className="notif-card-content">
                        <div className="notif-card-top">
                          <span className="notif-card-title">{item.title}</span>
                          {item.count > 1 ? (
                            <span className="wb-badge accent">×{item.count}</span>
                          ) : null}
                          {iso ? <span className="meta-time">{relativeTime(iso)}</span> : null}
                        </div>
                        {item.body ? <p className="notif-card-body">{item.body}</p> : null}
                      </div>
                      {navigable ? <ChevronRightIcon size={15} className="row-chevron" /> : null}
                    </button>
                    <button
                      type="button"
                      className="notif-dismiss-btn"
                      onClick={() => props.onDismiss(item.id)}
                      aria-label="Bildirimi kaldır"
                      title="Kaldır"
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
