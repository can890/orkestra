import { SettingsRow } from '@orkestra/ui/react/patterns';
import { Switch, toast } from '@orkestra/ui/react/primitives';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { useLocalHostSettings } from '../../browser/use-local-host-settings';

/**
 * Hızlı worktree checkout (macOS, yalnızca bu makine): yerel host ayarı
 * `fastWorktreeCheckout`. Kapatmak önbelleği siler. Başka platformlarda gizlenir.
 */
export function FastWorktreeCheckoutRow() {
  const supported = detectPlatformContext().os === 'mac';
  const { settings, isLoading, update } = useLocalHostSettings(supported);
  if (!supported) return null;
  const enabled = settings?.fastWorktreeCheckout === true;

  return (
    <SettingsRow
      label="Fast worktree checkout (beta)"
      description="Keep a few recent checkouts of each repository and create new worktrees on this Mac with APFS copy-on-write clones. The first worktree of a repository, sparse checkouts, Git LFS or other filters, changed checkout settings, other drives and Git older than 2.42 use the normal checkout. Turning it off deletes the cache."
      control={
        <Switch
          checked={enabled}
          disabled={isLoading || settings === undefined}
          aria-label="Fast worktree checkout"
          onCheckedChange={(checked) => {
            void update({ fastWorktreeCheckout: checked ? true : null }).catch((error: unknown) => {
              toast.error('Failed to save host settings', {
                description: error instanceof Error ? error.message : String(error),
              });
            });
          }}
        />
      }
    />
  );
}
