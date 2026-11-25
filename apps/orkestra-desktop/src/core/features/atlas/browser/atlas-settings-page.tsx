import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Button, Input, Switch, ToggleGroup, toast } from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import type { AtlasCardRecord, AtlasStatus } from '@core/features/atlas/api/atlas-model';
import { getAtlasClient } from '@core/features/atlas/api/browser/client';
import {
  toggleAtlasCardSkipCommand,
  writeAtlasCardCommand,
} from '@core/features/atlas/contributions/commands';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';

function formatTime(at: number): string {
  return new Date(at).toLocaleString();
}

function CardItem({ card }: { card: AtlasCardRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border bg-background-1 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground">{card.title}</div>
          <div className="truncate text-xs text-foreground-muted">
            {formatTime(card.writtenAt)} · {card.trigger === 'auto' ? 'automatic' : 'manual'} ·{' '}
            {card.tags.join(', ')}
          </div>
        </div>
        <Button variant="ghost" size="xs" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide' : 'Open'}
        </Button>
      </div>
      {open ? (
        <pre className="max-h-64 overflow-auto rounded bg-background-2 p-2 text-xs whitespace-pre-wrap">
          {card.text}
        </pre>
      ) : null}
    </li>
  );
}

/**
 * Ayarlar → Atlas: CLI algılama ve durum satırı, arama kaynağı ve otomatik kart anahtarları
 * (ikisi de varsayılan kapalı), kart dili ve son yazılan kartlar.
 */
export function AtlasSettingsPage() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('atlas');
  const [status, setStatus] = useState<AtlasStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [executable, setExecutable] = useState('');
  const disabled = isLoading || isSaving;

  const refresh = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      setStatus(await (await getAtlasClient()).getStatus({ refresh: force }));
    } catch (error) {
      toast.error('Could not read the Atlas status', { description: String(error) });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    setExecutable(value?.executable ?? '');
  }, [value?.executable]);

  const cli = status?.cli;
  const statusLine = !status
    ? 'Checking the atlas CLI…'
    : cli?.available
      ? `atlas CLI found: ${cli.executable}`
      : `atlas CLI not available: ${cli?.message ?? 'unknown error'}`;

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        title="Atlas"
        description="Connect Orkestra to your Atlas notes: search them as a knowledge source and write a short session card when work is archived."
      />
      <SettingsSection title="Status">
        <SettingsRow
          label="atlas CLI"
          description={
            <span>
              {statusLine}
              {status?.lastError ? (
                <span className="block text-foreground-destructive">
                  {`Last error (${formatTime(status.lastError.at)}): ${status.lastError.message}`}
                </span>
              ) : null}
            </span>
          }
          control={
            <Button
              variant="secondary"
              size="sm"
              disabled={checking}
              onClick={() => void refresh(true)}
            >
              Check again
            </Button>
          }
        />
        <SettingsRow
          label="CLI path"
          description="Leave empty to look for atlas on PATH and in ~/.local/bin. An explicit path must be absolute."
          control={
            <Input
              aria-label="CLI path"
              className="w-64"
              value={executable}
              placeholder="/Users/you/.local/bin/atlas"
              disabled={disabled}
              onChange={(event) => setExecutable(event.target.value)}
              onBlur={() => {
                if (executable.trim() !== (value?.executable ?? '')) {
                  update({ executable: executable.trim() });
                  void refresh(true);
                }
              }}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Knowledge source">
        <SettingsRow
          label="Search Atlas from agents and project memory"
          description="Adds a read-only orkestra-atlas tool server (atlas_search, atlas_project_history) to new conversations and an Atlas search box to the project memory panel. Note text is passed to agents as untrusted data."
          control={
            <Switch
              aria-label="Search Atlas from agents and project memory"
              checked={value?.searchEnabled ?? false}
              disabled={disabled}
              onCheckedChange={(checked) => update({ searchEnabled: checked })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Session cards">
        <SettingsRow
          label="Write a session card when a task is archived"
          description="For each conversation of the archived task that did real work, writes one short card (what was done, branch, commits, open items) with atlas kart. Never writes twice for the same conversation; failures never block archiving."
          control={
            <Switch
              aria-label="Write a session card when a task is archived"
              checked={value?.autoCardEnabled ?? false}
              disabled={disabled}
              onCheckedChange={(checked) => update({ autoCardEnabled: checked })}
            />
          }
        />
        <SettingsRow
          label="Card language"
          description="Cards are generated with the text generation model used for titles and commit messages; without it a plain summary is written."
          control={
            <ToggleGroup.Root
              multiple={false}
              value={[value?.cardLanguage ?? 'tr']}
              aria-label="Card language"
              onValueChange={([next]) => {
                if (next === 'tr' || next === 'en') update({ cardLanguage: next });
              }}
            >
              <ToggleGroup.Item value="tr">Turkish</ToggleGroup.Item>
              <ToggleGroup.Item value="en">English</ToggleGroup.Item>
            </ToggleGroup.Root>
          }
        />
        <SettingsRow
          label="Manual cards"
          // Komut adları tanımlardan gelir; böylece paletteki (çevrilmiş) adlarla aynı kalır.
          description={`Use the command palette: "${writeAtlasCardCommand.title}" or "${toggleAtlasCardSkipCommand.title}". Conversations marked "no card": ${status?.skippedConversations ?? 0}.`}
          control={null}
        />
      </SettingsSection>
      <SettingsSection title="Recently written cards" bare>
        {status && status.recentCards.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {status.recentCards.map((card) => (
              <CardItem key={`${card.conversationId}:${card.writtenAt}`} card={card} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-foreground-muted">No cards written yet.</p>
        )}
      </SettingsSection>
    </div>
  );
}
