import { comparer, reaction } from 'mobx';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { asAvailableProject } from '@core/features/projects/api/browser/stores/project-selectors';
import { projectManagerStoreToken } from '@core/features/projects/contributions/app-store-tokens';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import { SidebarNavigationController } from '@core/features/workbench/browser/sidebar/sidebar-navigation';
import { SidebarStore } from '@core/features/workbench/browser/sidebar/sidebar-store';
import { log } from '@core/primitives/logging/browser/logger';
import { navigationStoreToken } from '@core/primitives/navigation/browser/app-stores';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';

const sidebarStoreToken = scopedStoreToken<SidebarStore>('workbench.sidebar');
const sidebarSubscriptions = new WeakMap<SidebarStore, () => void>();
const sidebarNavigationControllerToken = scopedStoreToken<SidebarNavigationController>(
  'workbench.sidebar-navigation'
);

// SidebarStore resolves the projects store at create time, so the projects
// contribution must be registered before this one in the app-scope manifest.
export const workbenchAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: sidebarStoreToken,
    create: (_context, stores) => new SidebarStore(stores.get(projectManagerStoreToken)),
    activate: (sidebar) => {
      const loading = new Map<string, Set<string>>();
      let stopProjectSync: (() => void) | undefined;
      let disposed = false;
      let unsubscribe: (() => void) | undefined;
      void getConversationsClient()
        .then(async (client) => {
          if (disposed) return;
          const projects = getAppStores().get(projectManagerStoreToken);
          const availableProjectIds = () =>
            [...projects.projects.values()]
              .filter((project) => asAvailableProject(project))
              .map((project) => project.id);
          const refreshProject = (projectId: string) => {
            const liveIds = new Set<string>();
            loading.set(projectId, liveIds);
            void client
              .getConversationsForProject({ projectId })
              .then((conversations) => {
                if (loading.get(projectId) !== liveIds) return;
                sidebar.replaceProjectAttention(projectId, conversations, liveIds);
              })
              .catch((error) => log.warn('Sidebar conversation snapshot failed', error))
              .finally(() => {
                if (loading.get(projectId) === liveIds) loading.delete(projectId);
              });
          };
          const stop = await client.events.subscribe(undefined, {
            onEvent: (event) => {
              if (disposed) return;
              const location = event.type === 'created' ? event.conversation : event;
              const id = event.type === 'created' ? event.conversation.id : event.conversationId;
              if (event.type !== 'changed') loading.get(location.projectId)?.add(id);
              sidebar.handleConversationEvent(event);
            },
            onGap: () => {
              if (!disposed) availableProjectIds().forEach(refreshProject);
            },
          });
          if (disposed) stop();
          else {
            unsubscribe = stop;
            stopProjectSync = reaction(
              availableProjectIds,
              (current, previous = []) => {
                for (const projectId of previous) {
                  if (current.includes(projectId)) continue;
                  loading.delete(projectId);
                  sidebar.clearProjectAttention(projectId);
                }
                for (const projectId of current) {
                  if (previous.includes(projectId)) continue;
                  refreshProject(projectId);
                }
              },
              { fireImmediately: true, equals: comparer.structural }
            );
          }
        })
        .catch((error) => log.warn('Sidebar conversation event subscription failed', error));
      sidebarSubscriptions.set(sidebar, () => {
        disposed = true;
        unsubscribe?.();
        stopProjectSync?.();
        loading.clear();
      });
    },
    dispose: (sidebar) => {
      sidebarSubscriptions.get(sidebar)?.();
      sidebar.dispose();
    },
  }),
  contributeScopedStore({
    token: sidebarNavigationControllerToken,
    create: (_context, stores) => {
      const projects = stores.get(projectManagerStoreToken);
      return new SidebarNavigationController(
        stores.get(navigationStoreToken),
        stores.get(sidebarStoreToken),
        (projectId, taskId) => {
          const project = asAvailableProject(projects.projects.get(projectId));
          return project?.get(taskManagerStoreToken).tasks.get(taskId)?.data.isPinned === true;
        }
      );
    },
    activate: (controller) => controller.activate(),
    dispose: (controller) => controller.dispose(),
  }),
];

/** Returns the app-scoped SidebarStore. */
export function getSidebarStore(): SidebarStore {
  return getAppStores().get(sidebarStoreToken);
}
