import { SelectableCard, ToggleGroup } from '@orkestra/ui/react/primitives';
import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { AccentPreset, FontScale, Theme } from '@core/primitives/app-settings/api';
import { captureTelemetry } from '@core/primitives/telemetry/browser/telemetry-client';
import { useTheme } from '@core/primitives/theme/browser';

const themeOptions: Array<{
  value: Theme;
  label: string;
  ariaLabel: string;
  icon: LucideIcon;
}> = [
  { value: null, label: 'System', ariaLabel: 'Set theme to system preference', icon: Monitor },
  {
    value: 'emlight',
    label: 'Sovra Light',
    ariaLabel: 'Set theme to Sovra Light',
    icon: Sun,
  },
  { value: 'emdark', label: 'Sovra Dark', ariaLabel: 'Set theme to Sovra Dark', icon: Moon },
];

const ACCENT_PRESETS: Array<{ value: AccentPreset; label: string; swatch: string }> = [
  { value: 'default', label: 'Varsayılan', swatch: '#008753' },
  { value: 'ocean', label: 'Okyanus', swatch: '#0284c7' },
  { value: 'emerald', label: 'Zümrüt', swatch: '#059669' },
  { value: 'amber', label: 'Kehribar', swatch: '#d97706' },
  { value: 'violet', label: 'Mor', swatch: '#7c3aed' },
  { value: 'rose', label: 'Gül', swatch: '#e11d48' },
];

const FONT_SCALE_OPTIONS: Array<{ value: FontScale; label: string }> = [
  { value: 'compact', label: 'Kompakt (%94)' },
  { value: 'default', label: 'Varsayılan (%100)' },
  { value: 'comfortable', label: 'Rahat (%106)' },
];

const ThemeCard: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const { value: iface, update: updateInterface, isLoading } = useAppSettingsKey('interface');
  const accentPreset: AccentPreset = iface?.accentPreset ?? 'default';
  const fontScale: FontScale = iface?.fontScale ?? 'default';

  const handleSetTheme = (next: Theme) => {
    if (theme !== next) {
      captureTelemetry('setting_changed', { setting: 'theme' });
    }
    setTheme(next);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2 text-sm">
        {themeOptions.map(({ value, label, ariaLabel, icon: Icon }) => (
          <SelectableCard
            key={label}
            selected={theme === value}
            onClick={() => handleSetTheme(value)}
            aria-label={ariaLabel}
            aria-pressed={theme === value}
            className="min-h-24"
          >
            <span className="flex flex-col items-center justify-center gap-2 px-2 py-2.5 text-sm font-medium sm:px-3">
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-center">{label}</span>
            </span>
          </SelectableCard>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-(--em-surface) px-3 py-2.5 text-xs">
        <div>
          <div className="font-medium text-foreground">Vurgu rengi</div>
          <div className="text-[11px] text-foreground-muted">
            Seçili bileşenler ve birincil eylemler için tema vurgu tonunu özelleştirin.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {ACCENT_PRESETS.map((preset) => {
            const active = accentPreset === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                disabled={isLoading}
                onClick={() => updateInterface({ accentPreset: preset.value })}
                aria-label={`Vurgu rengi: ${preset.label}`}
                aria-pressed={active}
                title={preset.label}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition ${
                  active
                    ? 'border-foreground bg-background font-medium text-foreground'
                    : 'border-border bg-background/60 text-foreground-muted hover:text-foreground'
                }`}
              >
                <span
                  className="inline-flex h-3 w-3 items-center justify-center rounded-full"
                  style={{ backgroundColor: preset.swatch }}
                >
                  {active && <Check className="h-2.5 w-2.5 text-white" />}
                </span>
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-(--em-surface) px-3 py-2.5 text-xs">
        <div>
          <div className="font-medium text-foreground">Arayüz yazı ölçeği</div>
          <div className="text-[11px] text-foreground-muted">
            Uygulama genelindeki metin boyutunu rahat okuma için ölçekleyin.
          </div>
        </div>
        <ToggleGroup.Root
          multiple={false}
          value={[fontScale]}
          onValueChange={([next]) => {
            if (next === 'compact' || next === 'default' || next === 'comfortable') {
              updateInterface({ fontScale: next });
            }
          }}
        >
          {FONT_SCALE_OPTIONS.map((option) => (
            <ToggleGroup.Item key={option.value} size="sm" value={option.value} className="text-xs">
              {option.label}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      </div>
    </div>
  );
};

export default ThemeCard;
