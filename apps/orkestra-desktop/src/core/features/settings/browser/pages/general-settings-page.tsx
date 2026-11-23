import { PageLayout, SettingsSection } from '@orkestra/ui/react/patterns';
import { SnapshotSettingsCard } from '@core/features/snapshot/contributions/browser/snapshot-settings-card';
import { TextGenerationSettingsCard } from '@core/features/text-generation/contributions/browser/text-generation-settings-card';
import { ChatBehaviorSettingsCard } from '../components/ChatBehaviorSettingsCard';
import { ComputerUseSettingsSection } from '../components/ComputerUseSettingsSection';
import { KeepAwakeRow } from '../components/KeepAwakeRow';
import NotificationSettingsCard from '../components/NotificationSettingsCard';
import {
  AutoApproveByDefaultRow,
  AutoGenerateTaskNamesRow,
  AutoTrustWorktreesRow,
  CreateBranchAndWorktreeRow,
  DeleteBranchByDefaultRow,
  EnableTmuxRow,
  IncludeIssueContextByDefaultRow,
  PreserveTaskNameCapitalizationRow,
} from '../components/TaskSettingsRows';
import { UpdateCard } from '../components/UpdateCard';
import { WidgetsSettingsRow } from '../components/WidgetsSettingsRow';

export function GeneralSettingsPage() {
  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="General"
        description="Bildirimleri ve çalışma tercihlerinizi düzenleyin."
      />
      <SettingsSection title="Updates" bare>
        <UpdateCard />
      </SettingsSection>
      <SettingsSection title="Notifications" bare>
        <NotificationSettingsCard />
      </SettingsSection>
      <ComputerUseSettingsSection />
      <SnapshotSettingsCard />
      <TextGenerationSettingsCard />
      <ChatBehaviorSettingsCard />
      <SettingsSection title="Preferences">
        <AutoGenerateTaskNamesRow />
        <AutoApproveByDefaultRow />
        <AutoTrustWorktreesRow />
        <CreateBranchAndWorktreeRow />
        <DeleteBranchByDefaultRow />
        <PreserveTaskNameCapitalizationRow />
        <IncludeIssueContextByDefaultRow />
        <EnableTmuxRow />
        <KeepAwakeRow />
        <WidgetsSettingsRow />
      </SettingsSection>
    </div>
  );
}
