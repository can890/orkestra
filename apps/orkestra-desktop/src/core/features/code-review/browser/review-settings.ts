import {
  codeReviewSettingsMemento,
  DEFAULT_PROJECT_REVIEW_SETTINGS,
  type CodeReviewSettingsState,
  type ProjectReviewSettings,
} from '@core/features/code-review/contributions/mementos';
import { getMementoClient, type MementoHandle } from '@core/primitives/mementos/browser';
import { appSubject } from '@core/primitives/subjects/api';

/**
 * Proje başına inceleme ayarlarına başsız (React dışı) erişim. Ayarlar uygulama öznesindeki tek
 * bir mementoda tutulur; tutamak uygulama ömrü boyunca açık kalır.
 */
let handle: MementoHandle<CodeReviewSettingsState> | null = null;

function settingsHandle(): MementoHandle<CodeReviewSettingsState> {
  if (!handle) {
    handle = getMementoClient().subject(appSubject({})).handle(codeReviewSettingsMemento);
  }
  return handle;
}

/** Ayarlar yüklenince çözülür; okuma öncesi beklenmelidir (aksi halde varsayılan döner). */
export function codeReviewSettingsReady(): Promise<void> {
  return settingsHandle().ready;
}

/** MobX gözlemcilerinde kullanılabilir; değer değişince tepki verir. */
export function getProjectReviewSettings(projectId: string): ProjectReviewSettings {
  return settingsHandle().value.projects[projectId] ?? DEFAULT_PROJECT_REVIEW_SETTINGS;
}

export function updateProjectReviewSettings(
  projectId: string,
  patch: Partial<ProjectReviewSettings>
): void {
  settingsHandle().update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      [projectId]: {
        ...(current.projects[projectId] ?? DEFAULT_PROJECT_REVIEW_SETTINGS),
        ...patch,
      },
    },
  }));
}
