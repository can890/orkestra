import { createController, type Controller } from '@orkestra/wire/rpc';
import { projectRepositoriesContract } from '../api/contract';
import type { ProjectRepositoriesService } from '../api/node/project-repositories-service';

export function createProjectRepositoriesWireController(
  service: ProjectRepositoriesService
): Controller {
  return createController(projectRepositoriesContract, {
    listRepositories: (input) => service.listRepositories(input),
    discoverLocalFolder: (input) => service.discoverLocalFolder(input.path),
    listChanges: (input) => service.listChanges(input),
  });
}
