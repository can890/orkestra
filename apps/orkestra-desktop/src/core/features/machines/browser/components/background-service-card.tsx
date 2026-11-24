import { SettingsSection } from '@orkestra/ui/react/patterns';
import { Button, toast } from '@orkestra/ui/react/primitives';
import { useState } from 'react';

// Ayarlar > Makineler: Orkestra'yı başka bir makinede arka plan servisi olarak çalıştırmak için
// kopyalanacak komutlar. Uzaktan hiçbir şey çalıştırılmaz; kullanıcı komutu o makinede çalıştırır.

/** Orkestra'nın uzak makineye kurduğu workspace-server CLI'si (güncellemelerde `current` döner). */
export const REMOTE_WORKSPACE_SERVER_CLI =
  '~/.orkestra/workspace-server/current/bin/orkestra-workspace-server';

type Recipe = 'server' | 'desktop-host';

export function backgroundServiceCommands(recipe: Recipe): { label: string; command: string }[] {
  const cli = REMOTE_WORKSPACE_SERVER_CLI;
  if (recipe === 'server') {
    return [
      { label: 'Install and start', command: `${cli} service install` },
      { label: 'Check status and log path', command: `${cli} service status` },
      {
        label: 'Keep running after logout (Linux, as an administrator)',
        command: 'sudo loginctl enable-linger "$(id -un)"',
      },
    ];
  }
  return [
    {
      label: 'Install the workspace server first',
      command: `${cli} service install`,
    },
    {
      label: 'Install the headless app host (Linux, under Xvfb, sharing the server)',
      command: `${cli} service install --target desktop-host --app /path/to/Sovra.AppImage --workspace-socket`,
    },
    { label: 'Check status and log path', command: `${cli} service status --target desktop-host` },
  ];
}

export function BackgroundServiceCard() {
  const [recipe, setRecipe] = useState<Recipe>('server');
  return (
    <SettingsSection title="Run Orkestra as a background service">
      <div className="space-y-3 p-3 text-sm">
        <p className="text-foreground-muted">
          Run these commands on the remote machine (for example over SSH) so Orkestra keeps running
          without an open terminal. The service restarts after crashes, protects itself when agents
          use all memory, and writes its log to ~/.orkestra/service/logs. Edit
          ~/.orkestra/service/*.env for custom environment variables.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={recipe === 'server' ? 'primary' : 'secondary'}
            onClick={() => setRecipe('server')}
          >
            Workspace server
          </Button>
          <Button
            size="sm"
            variant={recipe === 'desktop-host' ? 'primary' : 'secondary'}
            onClick={() => setRecipe('desktop-host')}
          >
            Headless app host
          </Button>
        </div>
        {backgroundServiceCommands(recipe).map((entry) => (
          <CommandBlock key={entry.command} label={entry.label} command={entry.command} />
        ))}
        <p className="text-xs text-foreground-passive">
          Linux uses a systemd user service, macOS a LaunchAgent. Windows is not supported.
        </p>
      </div>
    </SettingsSection>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(command)
              .then(() => toast.success('Copied'))
              .catch(() => toast.error('Could not copy'));
          }}
        >
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-background-secondary p-2 text-xs break-all whitespace-pre-wrap">
        {command}
      </pre>
    </div>
  );
}
