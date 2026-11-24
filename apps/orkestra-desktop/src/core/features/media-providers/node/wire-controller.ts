import { createController, type Controller } from '@orkestra/wire/rpc';
import { mediaProvidersContract } from '@core/features/media-providers/api/contract';
import type { MediaProvidersService } from './media-providers-service';

export function createMediaProvidersWireController(service: MediaProvidersService): Controller {
  return createController(mediaProvidersContract, {
    status: ({ refresh }) => service.status(refresh === true),
  });
}
