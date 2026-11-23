import { useEffect, useState } from 'react';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import {
  getProjectManagerStore,
  getProjectStore,
  projectData,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { isFreeChatProjectId } from '@core/primitives/projects/api';

/**
 * True once the first project-list snapshot has been applied. Until then a missing project only
 * means "still loading", so callers must not present it as removed.
 */
export function useProjectsLoaded(): boolean {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const markLoaded = () => {
      if (active) setLoaded(true);
    };
    getProjectManagerStore().load().then(markLoaded, markLoaded);
    return () => {
      active = false;
    };
  }, []);
  return loaded;
}

/** Project display name, or undefined when the project is not in the store. Observer-only. */
export function boardProjectName(projectId: string): string | undefined {
  if (isFreeChatProjectId(projectId)) return 'Sohbet';
  return projectDisplayName(getProjectStore(projectId));
}

/**
 * Connection display name for SSH projects, undefined for local ones. Falls back to a neutral
 * label while the machines list has not resolved the connection. Observer-only.
 */
export function boardProjectHostLabel(projectId: string): string | undefined {
  const data = projectData(getProjectStore(projectId));
  if (data?.type !== 'ssh') return undefined;
  const connection = getMachinesStore().connections.find((entry) => entry.id === data.connectionId);
  return connection?.name || 'Remote';
}
