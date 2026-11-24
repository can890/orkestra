import { PageLayout, SettingsCard, SettingsSection } from '@orkestra/ui/react/patterns';
import { FastWorktreeCheckoutRow } from '@core/features/storage-cleanup/contributions/browser/FastWorktreeCheckoutRow';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import RepositorySettingsCard from '../components/RepositorySettingsCard';

export function RepositorySettingsPage() {
  return (
    <div className="space-y-8">
      <PageLayout.Header
        sticky
        title="Repository"
        description="Configure repository and branch settings."
      />
      <SettingsSection title="Branches" bare>
        <RepositorySettingsCard />
      </SettingsSection>
      {detectPlatformContext().os === 'mac' ? (
        <SettingsSection title="Worktrees" bare>
          <SettingsCard>
            <FastWorktreeCheckoutRow />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </div>
  );
}
