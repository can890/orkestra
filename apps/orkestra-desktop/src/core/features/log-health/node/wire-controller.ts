import { createController, type Controller } from '@orkestra/wire/rpc';
import { logHealthContract } from '../api/contract';
import type { LogHealthService } from './log-health-service';

export function createLogHealthWireController(service: LogHealthService): Controller {
  return createController(logHealthContract, {
    report: service.feedHost(),
    revealLogFile: async () => service.revealLogFile(),
  });
}
