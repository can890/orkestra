// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/settings/ThemeEditorHost.tsx,
// apps/web/src/components/settings/ThemeImportDialog.tsx
//
// Özel temalar: var olan bir temadan oluştur, taban renkleri canlı önizlemeyle düzenle,
// adlandır/çoğalt/sil, JSON olarak içe/dışa aktar (VS Code temaları dahil), "bir ajana sor".

import { Button, DropdownMenu, Input, toast } from '@orkestra/ui/react/primitives';
import { Bot, Check, Copy, Download, Palette, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { appearanceAgentGuide } from '../api/custom-css';
import {
  BUILT_IN_THEME_SEEDS,
  createThemeFrom,
  customThemeSchema,
  deriveThemeVars,
  duplicateTheme,
  MAX_CUSTOM_THEMES,
  serializeThemeFile,
  type CustomTheme,
  type CustomThemePalette,
} from '../api/custom-theme';
import { parseThemeImport } from '../api/theme-import';
import { DEFAULT_APPEARANCE_SETTINGS } from '../contributions/settings';
import { setThemePreview } from './theme-preview';

const PALETTE_FIELDS: ReadonlyArray<{
  key: keyof CustomThemePalette;
  label: string;
  optional: boolean;
}> = [
  { key: 'background', label: 'Background', optional: false },
  { key: 'foreground', label: 'Text', optional: true },
  { key: 'accent', label: 'Accent', optional: false },
  { key: 'success', label: 'Success', optional: true },
  { key: 'danger', label: 'Danger', optional: true },
  { key: 'warning', label: 'Warning', optional: true },
  { key: 'info', label: 'Info', optional: true },
];

function Swatches({ palette }: { palette: CustomThemePalette }) {
  return (
    <span className="flex items-center -space-x-1">
      {[palette.background, palette.foreground, palette.accent, palette.danger]
        .filter((color): color is string => Boolean(color))
        .map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="h-4 w-4 rounded-full border border-border"
            style={{ backgroundColor: color }}
          />
        ))}
    </span>
  );
}

export function CustomThemesSection() {
  const { value, update, isLoading } = useAppSettingsKey('appearance');
  const settings = value ?? DEFAULT_APPEARANCE_SETTINGS;
  const themes = settings.customThemes;
  const takenIds = useMemo(() => new Set(themes.map((theme) => theme.id)), [themes]);
  const [editing, setEditing] = useState<CustomTheme | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const saveThemes = (
    next: CustomTheme[],
    activeId: string | null = settings.activeCustomThemeId
  ) =>
    void update({
      customThemes: next,
      activeCustomThemeId:
        activeId && next.some((theme) => theme.id === activeId) ? activeId : null,
    });

  const addTheme = (theme: CustomTheme, activate: boolean) => {
    if (themes.length >= MAX_CUSTOM_THEMES) {
      toast.error(`You can keep up to ${MAX_CUSTOM_THEMES} custom themes.`);
      return;
    }
    saveThemes([...themes, theme], activate ? theme.id : settings.activeCustomThemeId);
  };

  const startCreate = (source: Pick<CustomTheme, 'name' | 'polarity' | 'palette'>) => {
    const created = createThemeFrom(source, `${source.name} custom`, takenIds);
    setEditing(created);
  };

  const exportTheme = async (theme: CustomTheme) => {
    const result = await (
      await getHostClient()
    ).saveTextFile({
      title: 'Export theme',
      defaultPath: `${theme.id}.orkestra-theme.json`,
      content: serializeThemeFile(theme),
    });
    if (!result.success) toast.error('Could not export the theme', { description: result.error });
    else if (result.path) toast.success('Theme exported');
  };

  const importFile = async (file: File) => {
    try {
      const theme = parseThemeImport(await file.text(), takenIds);
      addTheme(theme, true);
      toast.success(`Imported "${theme.name}"`);
    } catch (error) {
      toast.error('Could not import the theme', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const copyAgentGuide = async () => {
    try {
      await navigator.clipboard.writeText(appearanceAgentGuide());
      toast.success('Agent instructions copied', {
        description: 'Paste them into a conversation, then import the theme file the agent writes.',
      });
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            render={
              <Button type="button" variant="secondary" size="sm" disabled={isLoading}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Create theme
              </Button>
            }
          />
          <DropdownMenu.Content align="start">
            {BUILT_IN_THEME_SEEDS.map((seed) => (
              <DropdownMenu.Item key={seed.id} onClick={() => startCreate(seed)}>
                <Swatches palette={seed.palette} />
                From {seed.name}
              </DropdownMenu.Item>
            ))}
            {themes.length > 0 && <DropdownMenu.Separator />}
            {themes.map((theme) => (
              <DropdownMenu.Item key={theme.id} onClick={() => startCreate(theme)}>
                <Swatches palette={theme.palette} />
                From {theme.name}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={isLoading}
          onClick={() => importInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          Import theme…
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void copyAgentGuide()}>
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
          Ask an agent
        </Button>
        {settings.activeCustomThemeId && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void update({ activeCustomThemeId: null })}
          >
            Use built-in theme
          </Button>
        )}
        <input
          ref={importInputRef}
          type="file"
          accept=".json,.jsonc,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
      </div>
      <p className="text-[11px] text-foreground-muted">
        Import an Orkestra theme file or a VS Code color theme (.json). “Ask an agent” copies
        instructions you can paste into a conversation; the agent writes a theme file to import.
      </p>

      {themes.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {themes.map((theme) => {
            const active = settings.activeCustomThemeId === theme.id;
            return (
              <li key={theme.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                <Swatches palette={theme.palette} />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {theme.name}
                </span>
                <span className="text-[11px] text-foreground-muted">
                  {theme.polarity === 'light' ? 'Light' : 'Dark'}
                </span>
                {active ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-foreground">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Active
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => void update({ activeCustomThemeId: theme.id })}
                  >
                    Apply
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon
                  aria-label="Edit theme"
                  title="Edit theme"
                  onClick={() => setEditing(theme)}
                >
                  <Pencil aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon
                  aria-label="Duplicate theme"
                  title="Duplicate theme"
                  onClick={() => addTheme(duplicateTheme(theme, takenIds), false)}
                >
                  <Copy aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon
                  aria-label="Export theme"
                  title="Export theme"
                  onClick={() => void exportTheme(theme)}
                >
                  <Download aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon
                  aria-label="Delete theme"
                  title="Delete theme"
                  onClick={() =>
                    saveThemes(themes.filter((candidate) => candidate.id !== theme.id))
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <ThemeEditor
          key={editing.id}
          initial={editing}
          isNew={!takenIds.has(editing.id)}
          onCancel={() => setEditing(null)}
          onSave={(theme) => {
            const exists = themes.some((candidate) => candidate.id === theme.id);
            if (exists) {
              saveThemes(
                themes.map((candidate) => (candidate.id === theme.id ? theme : candidate))
              );
            } else {
              addTheme(theme, true);
            }
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ThemeEditor({
  initial,
  isNew,
  onCancel,
  onSave,
}: {
  initial: CustomTheme;
  isNew: boolean;
  onCancel: () => void;
  onSave: (theme: CustomTheme) => void;
}) {
  const [draft, setDraft] = useState<CustomTheme>(initial);
  // Yalnızca taslak değişince yeniden doğrula: önizleme referansı kararlı kalmalı.
  const valid = useMemo(() => {
    const parsed = customThemeSchema.safeParse(draft);
    return parsed.success ? parsed.data : null;
  }, [draft]);
  const derived = useMemo(() => (valid ? deriveThemeVars(valid) : null), [valid]);

  // Canlı önizleme: geçerli taslak uygulamaya hemen yansır; düzenleyici kapanınca kalkar.
  useEffect(() => {
    setThemePreview(valid);
  }, [valid]);
  useEffect(() => () => setThemePreview(null), []);

  const setPalette = (key: keyof CustomThemePalette, color: string | undefined) =>
    setDraft((current) => {
      const palette = { ...current.palette };
      if (color === undefined) delete palette[key];
      else palette[key] = color;
      return { ...current, palette };
    });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-(--em-surface) p-3 text-xs">
      <div className="flex items-center gap-2">
        <Palette className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-medium text-foreground">{isNew ? 'New theme' : 'Edit theme'}</span>
        <span className="text-[11px] text-foreground-muted">Changes preview live.</span>
      </div>
      <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
        <label htmlFor="appearance-theme-name">Name</label>
        <Input
          id="appearance-theme-name"
          value={draft.name}
          maxLength={48}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <span>Appearance</span>
        <div className="flex gap-1">
          {(['light', 'dark'] as const).map((polarity) => (
            <Button
              key={polarity}
              type="button"
              size="xs"
              variant={draft.polarity === polarity ? 'secondary' : 'ghost'}
              aria-pressed={draft.polarity === polarity}
              onClick={() => setDraft({ ...draft, polarity })}
            >
              {polarity === 'light' ? 'Light' : 'Dark'}
            </Button>
          ))}
        </div>
        {PALETTE_FIELDS.map(({ key, label, optional }) => {
          const color = draft.palette[key];
          return (
            <div key={key} className="contents">
              <label htmlFor={`appearance-color-${key}`}>{label}</label>
              <div className="flex items-center gap-2">
                <input
                  id={`appearance-color-${key}`}
                  type="color"
                  value={color ?? '#808080'}
                  disabled={optional && color === undefined}
                  onChange={(event) => setPalette(key, event.target.value)}
                  className="h-6 w-10 cursor-pointer rounded border border-border bg-transparent disabled:opacity-40"
                />
                <Input
                  aria-label={`${label} hex`}
                  value={color ?? ''}
                  placeholder={optional ? 'Derived' : '#rrggbb'}
                  className="w-28 font-mono"
                  onChange={(event) =>
                    setPalette(
                      key,
                      event.target.value.trim() === '' && optional ? undefined : event.target.value
                    )
                  }
                />
                {optional && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setPalette(key, color === undefined ? '#808080' : undefined)}
                  >
                    {color === undefined ? 'Set' : 'Use derived'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        <span>Contrast</span>
        <div className="flex gap-1">
          {(['normal', 'high'] as const).map((contrast) => (
            <Button
              key={contrast}
              type="button"
              size="xs"
              variant={draft.contrast === contrast ? 'secondary' : 'ghost'}
              aria-pressed={draft.contrast === contrast}
              onClick={() => setDraft({ ...draft, contrast })}
            >
              {contrast === 'normal' ? 'Normal' : 'High'}
            </Button>
          ))}
        </div>
        <label htmlFor="appearance-theme-vividness">Vividness</label>
        <input
          id="appearance-theme-vividness"
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={draft.vividness}
          onChange={(event) => setDraft({ ...draft, vividness: Number(event.target.value) })}
        />
      </div>
      {!valid && (
        <p role="alert" className="text-[11px] text-foreground-destructive">
          Some values are not valid colors.
        </p>
      )}
      {derived && derived.adjustments.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-foreground-warning">
          {derived.adjustments.map((adjustment) => (
            <li key={adjustment.token}>
              {`Adjusted ${adjustment.token.replace(/^--em-/, '')} for readability (contrast ${adjustment.before.toFixed(1)} → ${adjustment.after.toFixed(1)}, needs ${adjustment.required}).`}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!valid}
          onClick={() => valid && onSave(valid)}
        >
          Save theme
        </Button>
      </div>
    </div>
  );
}
