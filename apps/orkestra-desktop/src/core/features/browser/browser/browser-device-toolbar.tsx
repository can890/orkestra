// Adapted from pingdotgg/t3code (MIT) — responsive device emulation toolbar for browser panel.
import { Button, Tooltip } from '@orkestra/ui/react/primitives';
import { Monitor, RotateCw, Smartphone, Tablet, X } from 'lucide-react';
import { cn } from '@core/primitives/styling/browser/cn';

export type DevicePreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  icon: 'responsive' | 'mobile' | 'tablet' | 'desktop';
};

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: 'responsive', label: 'Esnek', width: 0, height: 0, icon: 'responsive' },
  { id: 'mobile', label: 'Telefon (393×852)', width: 393, height: 852, icon: 'mobile' },
  { id: 'tablet', label: 'Tablet (820×1180)', width: 820, height: 1180, icon: 'tablet' },
  { id: 'desktop', label: 'Masaüstü (1280×800)', width: 1280, height: 800, icon: 'desktop' },
];

export type DeviceViewportState = {
  presetId: string;
  width: number;
  height: number;
  rotated: boolean;
};

export function BrowserDeviceToolbar({
  viewport,
  onChange,
  onClose,
}: {
  viewport: DeviceViewportState;
  onChange: (next: DeviceViewportState) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background-secondary/60 px-2.5 text-xs">
      <div className="flex items-center gap-1">
        {DEVICE_PRESETS.map((preset) => {
          const active = viewport.presetId === preset.id;
          const Icon =
            preset.icon === 'mobile'
              ? Smartphone
              : preset.icon === 'tablet'
                ? Tablet
                : Monitor;
          return (
            <button
              key={preset.id}
              type="button"
              className={cn(
                'flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors',
                active
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-foreground-muted hover:bg-accent/50 hover:text-foreground'
              )}
              onClick={() =>
                onChange({
                  presetId: preset.id,
                  width: preset.width,
                  height: preset.height,
                  rotated: false,
                })
              }
            >
              <Icon className="size-3" />
              <span>{preset.id === 'responsive' ? 'Esnek' : preset.label.split(' ')[0]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1 text-[11px] text-foreground-muted tabular-nums">
        {viewport.width > 0 && viewport.height > 0 ? (
          <>
            <span>
              {viewport.rotated ? viewport.height : viewport.width}×
              {viewport.rotated ? viewport.width : viewport.height}
            </span>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon
                    className="size-6"
                    aria-label="Ekran yönünü çevir"
                    onClick={() => onChange({ ...viewport, rotated: !viewport.rotated })}
                  />
                }
              >
                <RotateCw className="size-3" />
              </Tooltip.Trigger>
              <Tooltip.Content>Yönü çevir</Tooltip.Content>
            </Tooltip.Root>
          </>
        ) : (
          <span>Tam alan</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon
          className="size-6"
          aria-label="Cihaz araç çubuğunu kapat"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
