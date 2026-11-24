import { SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Badge, Button, Switch, toast } from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import { getMediaProvidersClient } from '@core/features/media-providers/api/browser/client';
import {
  DEFAULT_MEDIA_PROVIDERS_SETTINGS,
  MEDIA_PROVIDER_IDS,
  MEDIA_PROVIDER_INFO,
  type MediaProviderId,
  type MediaProviderStatus,
} from '@core/features/media-providers/api/media-providers-model';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';

function statusLine(status: MediaProviderStatus | undefined): string {
  if (!status) return 'Checking the CLI…';
  if (!status.cli.path) return status.message ?? 'CLI not found.';
  const version = status.cli.version ? ` (${status.cli.version})` : '';
  const signIn =
    status.signedIn === true
      ? 'signed in'
      : status.signedIn === false
        ? 'not signed in'
        : 'sign-in unknown';
  return `${status.cli.path}${version} · ${signIn}${status.message ? ` · ${status.message}` : ''}`;
}

/**
 * Ayarlar → Entegrasyonlar: ElevenLabs'in yanında CLI tabanlı medya sağlayıcıları. Her biri
 * varsayılan kapalıdır; açılınca yeni yerel konuşmalara araç sunucusu eklenir.
 */
export function MediaProvidersCard() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('mediaProviders');
  const [statuses, setStatuses] = useState<MediaProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const settings = value ?? DEFAULT_MEDIA_PROVIDERS_SETTINGS;
  const disabled = isLoading || isSaving;
  const setProvider = (
    id: MediaProviderId,
    next: { enabled: boolean; requireConfirmation: boolean }
  ) => update(id === 'higgsfield' ? { higgsfield: next } : { flow: next });

  const refresh = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      setStatuses(await (await getMediaProvidersClient()).status({ refresh: force }));
    } catch (error) {
      toast.error('Could not check the media CLIs', { description: String(error) });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  return (
    <SettingsSection title="Media providers">
      <p className="text-xs leading-relaxed text-foreground-muted">
        Generate images and video from conversations through CLIs already signed in on this machine
        (ElevenLabs audio stays under MCP servers). Generation spends your credits: by default each
        generate call first returns a preview and runs only after you approve it. Results are saved
        in the conversation&apos;s orkestra-media folder and shown in the chat.
      </p>
      {MEDIA_PROVIDER_IDS.map((id) => {
        const info = MEDIA_PROVIDER_INFO[id];
        const status = statuses?.find((entry) => entry.id === id);
        const current = settings[id];
        return (
          <div key={id} className="flex flex-col gap-2">
            <SettingsRow
              label={
                <span className="flex items-center gap-2">
                  {info.title}
                  {status ? (
                    <Badge
                      tone={
                        status.cli.available && status.signedIn
                          ? 'success'
                          : status.cli.available
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {status.cli.available ? (status.signedIn ? 'ready' : 'CLI found') : 'missing'}
                    </Badge>
                  ) : null}
                </span>
              }
              description={
                <span>
                  {info.description}
                  <span className="block font-mono text-[11px]">{statusLine(status)}</span>
                </span>
              }
              control={
                <Switch
                  aria-label={`Enable ${info.title}`}
                  checked={current.enabled}
                  disabled={disabled}
                  onCheckedChange={(enabled) => setProvider(id, { ...current, enabled })}
                />
              }
            />
            <SettingsRow
              label="Ask before spending credits"
              description="Generate calls return a preview first; the agent runs them only after you approve (confirm_spend). Your agent's own tool approval still applies."
              control={
                <Switch
                  aria-label={`Ask before spending ${info.title} credits`}
                  checked={current.requireConfirmation}
                  disabled={disabled || !current.enabled}
                  onCheckedChange={(requireConfirmation) =>
                    setProvider(id, { ...current, requireConfirmation })
                  }
                />
              }
            />
          </div>
        );
      })}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={checking}
          onClick={() => void refresh(true)}
        >
          Check CLIs again
        </Button>
      </div>
    </SettingsSection>
  );
}
