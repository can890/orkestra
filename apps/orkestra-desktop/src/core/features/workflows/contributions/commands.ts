import { defineCommand } from '@core/primitives/commands/api';

// Varsayılan kısayol yok: mevcut kısayollarla çakışmasın.
export const openWorkflowsCommand = defineCommand({
  id: 'workflows.open',
  title: 'Open Workflows',
  description: 'Durable workflows written as code, their runs and questions',
  category: 'App',
});

export const WORKFLOWS_COMMAND_DEFS = [openWorkflowsCommand] as const;
