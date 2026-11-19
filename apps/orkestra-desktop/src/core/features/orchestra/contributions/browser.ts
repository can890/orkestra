import { workflowEditorModal } from '@core/features/orchestra/contributions/browser/workflow-editor-modal';
import { workflowRunModal } from '@core/features/orchestra/contributions/browser/workflow-run-modal';

export const orchestraWorkflowBrowserContributions = {
  modalDefs: [workflowEditorModal, workflowRunModal],
} as const;
