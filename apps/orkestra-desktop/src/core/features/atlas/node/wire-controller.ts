import { createController, type Controller } from '@orkestra/wire/rpc';
import { atlasContract } from '@core/features/atlas/api/contract';
import type { AtlasService } from './atlas-service';

export function createAtlasWireController(service: AtlasService): Controller {
  return createController(atlasContract, {
    getStatus: ({ refresh }) => service.status(refresh === true),
    search: ({ query, limit }) => service.search(query, limit),
    projectHistory: ({ projectId }) => service.projectHistory(projectId),
    writeCard: ({ conversationId }) => service.writeCard(conversationId, 'manual'),
    conversationState: ({ conversationId }) => service.conversationState(conversationId),
    setSkipped: ({ conversationId, skipped }) => service.setSkipped(conversationId, skipped),
  });
}
