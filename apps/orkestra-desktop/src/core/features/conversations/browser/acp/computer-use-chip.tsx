import { Button, toast } from '@orkestra/ui/react/primitives';
import { MonitorUp, OctagonX } from 'lucide-react';
import { useState } from 'react';
import type {
  ComputerUseLogEntry,
  ComputerUsePermissionPane,
  ComputerUsePermissions,
} from '@core/features/computer-use/api';
import { getComputerUseClient } from '@core/features/computer-use/api/browser/client';
import { useComputerUseState } from '@core/features/computer-use/api/browser/use-computer-use-state';

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('tr-TR');
}

function ActivityList({ entries }: { entries: ComputerUseLogEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-foreground-muted">Henüz bir eylem yok.</p>;
  }
  return (
    <ul className="max-h-40 space-y-0.5 overflow-auto font-mono text-[11px] text-foreground-muted">
      {[...entries].reverse().map((entry) => (
        <li key={`${entry.at}-${entry.tool}-${entry.summary}`}>
          {formatTime(entry.at)} {entry.summary}
          {entry.outcome === 'ok' ? '' : ` [${entry.outcome === 'denied' ? 'reddedildi' : 'hata'}]`}
        </li>
      ))}
    </ul>
  );
}

function MissingPermissionLinks({
  permissions,
  onOpenPane,
}: {
  permissions: ComputerUsePermissions;
  onOpenPane: (pane: ComputerUsePermissionPane) => void;
}) {
  return (
    <>
      {!permissions.accessibility ? (
        <button
          type="button"
          className="text-foreground underline"
          onClick={() => onOpenPane('accessibility')}
        >
          Erişilebilirlik
        </button>
      ) : null}
      {!permissions.accessibility && !permissions.screenRecording ? ', ' : null}
      {!permissions.screenRecording ? (
        <button
          type="button"
          className="text-foreground underline"
          onClick={() => onOpenPane('screen-recording')}
        >
          Ekran Kaydı
        </button>
      ) : null}
    </>
  );
}

/**
 * Yazı kutusunun üstünde: genel ayar açıkken yalnızca eksik izin uyarısı, aktif kullanım
 * kartı ("Durdur" + etkinlik günlüğü) veya kullanıcı bu sohbeti durdurduysa tek tıkla
 * yeniden açma hapı gösterir. Yeni/boş sohbette izinler tamken hiçbir şey çizmez.
 * macOS dışında, SSH projelerinde ve genel ayar kapalıyken hiçbir şey çizmez.
 */
export function ComputerUseChip({
  conversationId,
  remote,
}: {
  conversationId: string;
  remote: boolean;
}) {
  const { state, setEnabled, stop } = useComputerUseState(conversationId);
  const [showLog, setShowLog] = useState(false);

  if (!state || !state.supported || remote) return null;
  const { globalEnabled, conversationEnabled, permissions, activity } = state;
  if (!globalEnabled) return null;

  const missingPermission = !permissions.accessibility || !permissions.screenRecording;
  const openPane = (pane: ComputerUsePermissionPane) => {
    void getComputerUseClient().then((client) => client.openPermissionSettings({ pane }));
  };

  if (!conversationEnabled) {
    return (
      <button
        type="button"
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-(--em-surface) px-2.5 py-1 text-xs text-foreground-muted shadow-sm hover:text-foreground"
        onClick={() => {
          void setEnabled(true).then((result) => {
            if (!result.success) toast.error(result.error);
          });
        }}
      >
        <MonitorUp className="size-3" />
        Bilgisayar kullanımı bu sohbette durduruldu · Tekrar aç
      </button>
    );
  }

  if (activity.length === 0) {
    if (!missingPermission) return null;
    return (
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-(--em-surface) px-2.5 py-1 text-xs text-foreground-muted shadow-sm">
        <MonitorUp className="size-3 shrink-0" />
        <span>
          macOS izni eksik:{' '}
          <MissingPermissionLinks permissions={permissions} onOpenPane={openPane} />
        </span>
      </div>
    );
  }

  return (
    <div className="border-danger/60 pointer-events-auto w-80 space-y-2 rounded-lg border bg-(--em-surface) p-2.5 text-xs shadow-md">
      <div className="flex items-center gap-2">
        <span className="relative flex size-2 shrink-0">
          <span className="bg-danger absolute inline-flex size-full animate-ping rounded-full opacity-60" />
          <span className="bg-danger relative inline-flex size-2 rounded-full" />
        </span>
        <span className="flex-1 font-medium text-foreground">Masaüstü kontrolü açık</span>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void stop()}
          aria-label="Bilgisayar kullanımını durdur"
        >
          <OctagonX className="size-3" />
          Durdur
        </Button>
      </div>
      {missingPermission ? (
        <p className="text-foreground-muted">
          macOS izni eksik:{' '}
          <MissingPermissionLinks permissions={permissions} onOpenPane={openPane} />. İzni siz
          verin; ajan veremez.
        </p>
      ) : null}
      <button
        type="button"
        className="text-foreground-muted underline"
        onClick={() => setShowLog((value) => !value)}
      >
        {showLog ? 'Günlüğü gizle' : `Etkinlik günlüğü (${activity.length})`}
      </button>
      {showLog ? <ActivityList entries={activity} /> : null}
    </div>
  );
}
