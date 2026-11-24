// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/themeBackground.ts
//
// Arka plan görseli: yerel bir görsel seçilir, baytları uygulama verisine kopyalanır (özgün yol
// saklanmaz) ve sohbet yüzeyinin arkasında opaklık/bulanıklık/karartma ayarlarıyla gösterilir.

import { Button, Switch, toast } from '@orkestra/ui/react/primitives';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import {
  BACKGROUND_IMAGE_MAX_BYTES,
  isBackgroundMimeType,
  MAX_BACKGROUND_BLUR_PX,
  MAX_BACKGROUND_DIM,
  MIN_BACKGROUND_DIM,
  normalizeBackground,
  type BackgroundSettings,
} from '../api/background';
import { getAppearanceClient } from '../api/browser/client';
import { DEFAULT_APPEARANCE_SETTINGS } from '../contributions/settings';

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function BackgroundImageSection() {
  const { value, update, isLoading } = useAppSettingsKey('appearance');
  const background = (value ?? DEFAULT_APPEARANCE_SETTINGS).background;
  const inputRef = useRef<HTMLInputElement | null>(null);

  const save = (next: BackgroundSettings) => void update({ background: normalizeBackground(next) });

  const pick = async (file: File) => {
    if (!isBackgroundMimeType(file.type)) {
      toast.error('Choose a JPEG, PNG, WebP or GIF image');
      return;
    }
    if (file.size > BACKGROUND_IMAGE_MAX_BYTES) {
      toast.error('That image is too large', {
        description: `Images up to ${BACKGROUND_IMAGE_MAX_BYTES / 1024 / 1024} MB are supported.`,
      });
      return;
    }
    const client = await getAppearanceClient();
    const result = await client.saveBackgroundImage({
      mimeType: file.type,
      dataBase64: await fileToBase64(file),
    });
    if (!result.ok) {
      toast.error('Could not use that image', {
        description:
          result.reason === 'too-large'
            ? 'The image is too large.'
            : result.reason === 'unsupported-type'
              ? 'The file is not a supported image.'
              : 'It could not be copied into the app data folder.',
      });
      return;
    }
    save({ ...background, enabled: true, fileName: result.fileName });
    void client.pruneBackgroundImages({ keep: result.fileName });
  };

  const remove = async () => {
    save({ ...background, enabled: false, fileName: null });
    void (await getAppearanceClient()).pruneBackgroundImages({ keep: null });
  };

  const slider = (
    id: string,
    label: string,
    min: number,
    max: number,
    step: number,
    current: number,
    format: (value: number) => string,
    apply: (value: number) => BackgroundSettings
  ) => (
    <div className="contents">
      <label htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={current}
          disabled={!background.fileName}
          onChange={(event) => save(apply(Number(event.target.value)))}
          className="flex-1"
        />
        <span className="w-12 text-right text-foreground-muted tabular-nums">
          {format(current)}
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-foreground">Background image</div>
          <div className="text-[11px] text-foreground-muted">
            Shown behind the conversation. The image is copied into the app’s data folder; a scrim
            of the chat background always stays over it so text remains readable.
          </div>
        </div>
        <Switch
          aria-label="Show background image"
          checked={background.enabled}
          disabled={isLoading || !background.fileName}
          onCheckedChange={(enabled) => save({ ...background, enabled })}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={isLoading}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
          {background.fileName ? 'Change image…' : 'Choose image…'}
        </Button>
        {background.fileName && (
          <Button type="button" size="sm" variant="ghost" onClick={() => void remove()}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Remove
          </Button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void pick(file);
          }}
        />
      </div>
      <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
        {slider(
          'appearance-bg-opacity',
          'Opacity',
          0,
          1,
          0.05,
          background.opacity,
          (v) => `${Math.round(v * 100)}%`,
          (opacity) => ({ ...background, opacity })
        )}
        {slider(
          'appearance-bg-blur',
          'Blur',
          0,
          MAX_BACKGROUND_BLUR_PX,
          1,
          background.blur,
          (v) => `${v}px`,
          (blur) => ({ ...background, blur })
        )}
        {slider(
          'appearance-bg-dim',
          'Dim',
          MIN_BACKGROUND_DIM,
          MAX_BACKGROUND_DIM,
          0.01,
          Math.max(MIN_BACKGROUND_DIM, background.dim),
          (v) => `${Math.round(v * 100)}%`,
          (dim) => ({ ...background, dim })
        )}
      </div>
    </div>
  );
}
