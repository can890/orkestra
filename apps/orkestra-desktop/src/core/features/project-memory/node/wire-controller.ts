import { createController, type Controller } from '@orkestra/wire/rpc';
import { projectMemoryContract } from '../api/contract';
import type { ProjectMemoryService } from './project-memory-service';

export function createProjectMemoryWireController(service: ProjectMemoryService): Controller {
  return createController(projectMemoryContract, {
    getState: ({ projectId }) => service.state(projectId),
    setEnabled: ({ projectId, enabled }) => service.setEnabled(projectId, enabled),
    read: ({ projectId, name }) => service.read(projectId, name),
    write: ({ projectId, name, description, content }) =>
      service.write(projectId, { name, description, content }),
    remove: ({ projectId, name }) => service.remove(projectId, name),
    promptContext: ({ projectId }) => service.promptContext(projectId),
  });
}
