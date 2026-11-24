// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: docs/user/appearance.md "Custom CSS"
//
// Özel CSS düzenleyicisi. Bu bölüm güvenli bölgededir (`data-appearance-safe-zone`): kullanıcı
// kuralları ona ulaşamaz, bu yüzden "kapat" düğmesi her zaman kullanılabilir kalır.

import { Button, Switch, Textarea } from '@orkestra/ui/react/primitives';
import { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import {
  CUSTOM_CSS_HOOKS,
  CUSTOM_CSS_MAX_LENGTH,
  CUSTOM_CSS_VARIABLES,
  cssLoadsRemoteFiles,
  SAFE_ZONE_ATTRIBUTE,
} from '../api/custom-css';
import { DEFAULT_APPEARANCE_SETTINGS } from '../contributions/settings';
import { CUSTOM_CSS_CONFIRM_SECONDS } from './use-custom-appearance';

const RESCUE_SHORTCUT = detectPlatformContext().os === 'mac' ? '⌘⌥⇧C' : 'Ctrl+Alt+Shift+C';

export function CustomCssSection() {
  const { value, update, isLoading } = useAppSettingsKey('appearance');
  const customCss = (value ?? DEFAULT_APPEARANCE_SETTINGS).customCss;
  const [draft, setDraft] = useState(customCss.css);
  useEffect(() => setDraft(customCss.css), [customCss.css]);
  const dirty = draft !== customCss.css;

  return (
    <div {...{ [SAFE_ZONE_ATTRIBUTE]: '' }} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-foreground">Custom CSS</div>
          <div className="text-[11px] text-foreground-muted">
            Applied after the app’s own styles. New CSS must be confirmed within{' '}
            {CUSTOM_CSS_CONFIRM_SECONDS} seconds or it is turned off again; unconfirmed CSS is never
            applied at launch. Press {RESCUE_SHORTCUT} anywhere to turn it off.
          </div>
        </div>
        <Switch
          aria-label="Enable custom CSS"
          checked={customCss.enabled}
          disabled={isLoading || customCss.css.trim().length === 0}
          onCheckedChange={(enabled) => void update({ customCss: { ...customCss, enabled } })}
        />
      </div>
      <Textarea
        aria-label="Custom CSS"
        value={draft}
        maxLength={CUSTOM_CSS_MAX_LENGTH}
        spellCheck={false}
        rows={8}
        className="font-mono text-[12px]"
        placeholder={'.emdark [data-chat-surface] {\n  --chat-bubble-user: #1d2a3a;\n}'}
        onChange={(event) => setDraft(event.target.value)}
      />
      {cssLoadsRemoteFiles(draft) && (
        <p role="alert" className="text-[11px] text-foreground-warning">
          Custom CSS cannot load files: @import, image-set() and url() other than data: or #id are
          removed.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!dirty}
          onClick={() => setDraft(customCss.css)}
        >
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!dirty || isLoading}
          onClick={() =>
            void update({
              customCss: { ...customCss, css: draft, enabled: draft.trim().length > 0 },
            })
          }
        >
          Save and apply
        </Button>
      </div>
      <details className="text-[11px] text-foreground-muted">
        <summary className="cursor-pointer select-none">Stable selectors and variables</summary>
        <p className="mt-2">
          Class names change between releases. Target these selectors and theme variables instead;
          use .emdark or .emlight for one appearance and add !important if a rule has no effect.
        </p>
        <ul className="mt-2 space-y-0.5 font-mono">
          {CUSTOM_CSS_HOOKS.map((hook) => (
            <li key={hook.selector}>
              {hook.selector} <span className="font-sans">— {hook.styles}</span>
            </li>
          ))}
        </ul>
        <ul className="mt-2 space-y-0.5 font-mono">
          {CUSTOM_CSS_VARIABLES.map((variable) => (
            <li key={variable.name}>
              {variable.name} <span className="font-sans">— {variable.meaning}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
