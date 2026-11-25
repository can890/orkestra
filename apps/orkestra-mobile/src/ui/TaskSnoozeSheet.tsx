import { useEffect, useState } from 'react';
import { SNOOZE_DURATIONS } from '@/core/task-snoozes';
import { ErrorNote } from './components';
import { pushOverlayBack } from './overlay-back';

export function TaskSnoozeSheet(props: {
  title: string;
  error: string | null;
  onSelect: (durationMs: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => pushOverlayBack(props.onClose), [props.onClose]);
  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="Görevi ertele">
      <div className="sheet-backdrop" onClick={() => !busy && props.onClose()} />
      <div className="sheet-panel">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <strong>{props.title} · Ertele</strong>
        </div>
        {props.error ? <ErrorNote message={props.error} /> : null}
        <div className="mac-section-actions">
          {SNOOZE_DURATIONS.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const saved = await props.onSelect(value);
                setBusy(false);
                if (saved) props.onClose();
              }}
            >
              {label}
            </button>
          ))}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={props.onClose}>
            Vazgeç
          </button>
        </div>
      </div>
    </div>
  );
}
