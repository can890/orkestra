import { PageLayout, SettingsSection } from '@orkestra/ui/react/patterns';
import { SnapshotSettingsCard } from '@core/features/snapshot/contributions/browser/snapshot-settings-card';
import { TextGenerationSettingsCard } from '@core/features/text-generation/contributions/browser/text-generation-settings-card';
import { WorkflowsSettingsRow } from '@core/features/workflows/contributions/browser/workflows-settings-row';
import { ChatBehaviorSettingsCard } from '../components/ChatBehaviorSettingsCard';
import { ComputerUseSettingsSection } from '../components/ComputerUseSettingsSection';
import { KeepAwakeRow } from '../components/KeepAwakeRow';
import NotificationSettingsCard from '../components/NotificationSettingsCard';
import {
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
        title="Genel"
        description="Bildirimleri ve çalışma tercihlerinizi düzenleyin."
      />
      <SettingsSection title="Güncellemeler" bare>
        <UpdateCard />
      </SettingsSection>
      <SettingsSection title="Bildirimler" bare>
        <NotificationSettingsCard />
      </SettingsSection>
      <ComputerUseSettingsSection />
      <SnapshotSettingsCard />
      <TextGenerationSettingsCard />
      <ChatBehaviorSettingsCard />
      <SettingsSection title="Tercihler">
        <AutoGenerateTaskNamesRow />
        <AutoTrustWorktreesRow />
        <CreateBranchAndWorktreeRow />
        <DeleteBranchByDefaultRow />
        <PreserveTaskNameCapitalizationRow />
        <IncludeIssueContextByDefaultRow />
        <EnableTmuxRow />
        <KeepAwakeRow />
        <WidgetsSettingsRow />
        <WorkflowsSettingsRow />
      </SettingsSection>
    </div>
  );
}
