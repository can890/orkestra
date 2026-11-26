import { Button, Dialog } from '@orkestra/ui/react/primitives';
import { CalendarClock } from 'lucide-react';
import { useEffect, useState } from 'react';

function toLocalDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toLocalTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function defaultTomorrowMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 30, 0, 0);
  return d;
}

function tonightAt20(): Date {
  const d = new Date();
  if (d.getHours() >= 20) d.setDate(d.getDate() + 1);
  d.setHours(20, 0, 0, 0);
  return d;
}

function nextMondayMorning(): Date {
  const d = new Date();
  const daysUntilMon = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + daysUntilMon);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function CustomSnoozeDialog({
  open,
  taskName,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  taskName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (untilMs: number) => void;
}) {
  const [dateStr, setDateStr] = useState(() => toLocalDateInput(defaultTomorrowMorning()));
  const [timeStr, setTimeStr] = useState(() => toLocalTimeInput(defaultTomorrowMorning()));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const def = defaultTomorrowMorning();
    setDateStr(toLocalDateInput(def));
    setTimeStr(toLocalTimeInput(def));
    setError(null);
  }, [open]);

  const applyPreset = (d: Date) => {
    setDateStr(toLocalDateInput(d));
    setTimeStr(toLocalTimeInput(d));
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = new Date(`${dateStr}T${timeStr}`);
    const ms = parsed.getTime();
    if (!Number.isFinite(ms) || ms <= Date.now() + 10_000) {
      setError('Lütfen şu andan ileri bir tarih ve saat seçin.');
      return;
    }
    onConfirm(ms);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="max-w-sm">
        <Dialog.Header>
          <Dialog.Title className="flex items-center gap-2 text-sm">
            <CalendarClock className="size-4 text-sky-400" />
            Özel tarih / saat erteleme
          </Dialog.Title>
          <Dialog.Description className="truncate text-xs text-foreground-muted">
            {taskName}
          </Dialog.Description>
        </Dialog.Header>

        <form onSubmit={handleSubmit} className="space-y-3 pt-2">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => applyPreset(tonightAt20())}
              className="cursor-pointer rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[11px] text-foreground-muted transition-colors hover:bg-white/[0.09] hover:text-foreground"
            >
              Bu akşam 20:00
            </button>
            <button
              type="button"
              onClick={() => applyPreset(defaultTomorrowMorning())}
              className="cursor-pointer rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[11px] text-foreground-muted transition-colors hover:bg-white/[0.09] hover:text-foreground"
            >
              Yarın 09:30
            </button>
            <button
              type="button"
              onClick={() => applyPreset(nextMondayMorning())}
              className="cursor-pointer rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[11px] text-foreground-muted transition-colors hover:bg-white/[0.09] hover:text-foreground"
            >
              Pazartesi 09:00
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-foreground-muted">
              <span>Tarih</span>
              <input
                type="date"
                value={dateStr}
                min={toLocalDateInput(new Date())}
                onChange={(e) => {
                  setDateStr(e.target.value);
                  setError(null);
                }}
                className="h-8 rounded-md border border-white/[0.12] bg-[#0c0c0e] px-2.5 text-xs text-foreground outline-none focus:border-sky-400/70"
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-foreground-muted">
              <span>Saat</span>
              <input
                type="time"
                value={timeStr}
                onChange={(e) => {
                  setTimeStr(e.target.value);
                  setError(null);
                }}
                className="h-8 rounded-md border border-white/[0.12] bg-[#0c0c0e] px-2.5 text-xs text-foreground outline-none focus:border-sky-400/70"
                required
              />
            </label>
          </div>

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              İptal
            </Button>
            <Button type="submit" size="sm" variant="primary">
              Ertele
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
