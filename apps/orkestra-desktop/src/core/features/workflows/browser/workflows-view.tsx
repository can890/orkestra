import { type ReactNode } from 'react';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { workflowsViewDef } from '@core/features/workflows/contributions/views';
import { defineViewRuntime } from '@core/primitives/views/react';
import { WorkflowsPage } from './workflows-page';

export function WorkflowsViewWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function WorkflowsBreadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 px-2">
      <span className="rounded-sm px-1 py-0.5 text-sm text-foreground">Workflows</span>
    </nav>
  );
}

export function WorkflowsTitlebar() {
  return <Titlebar leftSlot={<WorkflowsBreadcrumb />} />;
}

export const workflowsViewRuntime = defineViewRuntime(workflowsViewDef, {
  slots: {
    wrap: WorkflowsViewWrapper,
    titlebar: WorkflowsTitlebar,
    main: WorkflowsPage,
  },
});
