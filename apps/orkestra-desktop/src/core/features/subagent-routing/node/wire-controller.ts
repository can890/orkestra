import { createController, type Controller } from '@orkestra/wire/rpc';
import { subagentRoutingContract } from '@core/features/subagent-routing/api/contract';
import type { SubagentRoutingSync } from './routing-sync';

export function createSubagentRoutingWireController(sync: SubagentRoutingSync): Controller {
  return createController(subagentRoutingContract, {
    preview: ({ refresh }) => sync.preview(refresh === true),
  });
}
