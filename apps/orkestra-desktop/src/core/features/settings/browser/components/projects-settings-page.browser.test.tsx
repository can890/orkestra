import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { projectsSettingsPage } from '@core/features/projects/contributions/settings-page';
import { resolveDetailLevels } from './settings-detail-path';

const fixture = vi.hoisted(() => ({
  data: { id: 'project-1', name: 'Orkestra', path: '/projects/orkestra', type: 'local' },
  context: { kind: 'available' },
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map([[fixture.data.id, fixture]]) }),
  getProjectStore: (id: string) => (id === fixture.data.id ? fixture : undefined),
}));

vi.mock('@core/features/projects/contributions/browser/project-view-wrapper', () => ({
  ProjectViewWrapper: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@core/features/projects/contributions/browser/project-availability-boundary', () => ({
  ProjectAvailabilityBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@core/features/projects/browser/components/pr-view/pr-view', () => ({
  PullRequestView: ({ projectId }: { projectId: string }) => <div>PRs for {projectId}</div>,
}));

vi.mock(
  '@core/features/projects/browser/components/workspaces-view/project-workspaces-view',
  () => ({
    ProjectWorkspacesView: ({ projectId }: { projectId: string }) => (
      <div>Workspaces for {projectId}</div>
    ),
  })
);

vi.mock('@core/features/projects/browser/components/settings-view/settings-panel', () => ({
  SettingsPanel: ({ projectId }: { projectId: string }) => <div>Settings for {projectId}</div>,
}));

vi.mock('@core/features/project-memory/contributions/project-memory-panel', () => ({
  ProjectMemoryPanel: () => null,
}));

vi.mock(
  '@core/features/project-repositories/contributions/browser/project-repositories-panel',
  () => ({ ProjectRepositoriesPanel: () => null })
);

function SettingsDetailHarness() {
  const [path, setPath] = useState<string[]>([]);
  const level = resolveDetailLevels(projectsSettingsPage, path).at(-1);
  const openDetail = (id: string) => setPath((current) => [...current, id]);
  const closeDetail = () => setPath((current) => current.slice(0, -1));

  if (!level) return <projectsSettingsPage.component openDetail={openDetail} />;
  return (
    <>
      <button type="button" onClick={closeDetail}>
        Back
      </button>
      <level.contribution.component
        path={path}
        detailId={path.at(-1)!}
        openDetail={openDetail}
        closeDetail={closeDetail}
      />
    </>
  );
}

it('opens all three management sections for the selected project from Settings', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  async function click(label: string) {
    const button = Array.from(host.querySelectorAll('button')).find((item) =>
      item.textContent?.includes(label)
    );
    expect(button, label).toBeDefined();
    await act(async () => button?.click());
  }

  try {
    await act(async () => root.render(<SettingsDetailHarness />));
    await click('Orkestra');
    for (const [label, content] of [
      ['Pull Requests', 'PRs for project-1'],
      ['Workspaces', 'Workspaces for project-1'],
      ['Project settings', 'Settings for project-1'],
    ] as const) {
      await click(label);
      expect(host.textContent).toContain(content);
      await click('Back');
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
