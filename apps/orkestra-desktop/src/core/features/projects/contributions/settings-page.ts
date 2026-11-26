import { getProjectStore } from '@core/features/projects/api/browser/stores/project-selectors';
import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import { isFreeChatProjectId } from '@core/primitives/projects/api';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import {
  projectSettingsSections,
  ProjectsSettingsPage,
  ProjectSettingsOverview,
  ProjectSettingsSection,
} from '../browser/components/settings-view/projects-settings-page';

export const projectsSettingsPage = defineSettingsPageContribution({
  id: 'projects',
  label: 'Projects',
  icon: 'folder-open',
  component: ProjectsSettingsPage,
  detail: {
    component: ProjectSettingsOverview,
    breadcrumbLabel: ([projectId]) =>
      projectId && !isFreeChatProjectId(projectId)
        ? (getProjectStore(projectId)?.data?.name ?? null)
        : null,
    child: {
      component: ProjectSettingsSection,
      breadcrumbLabel: ([, section]) =>
        projectSettingsSections.find(({ id }) => section === id)?.label ?? null,
    },
  },
} satisfies SettingsPageContribution<SettingsPageTab>);
