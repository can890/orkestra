import { createController, type Controller } from '@orkestra/wire/rpc';
import { acpRegistryContract } from '../api/contract';
import type { AcpRegistryService } from './service';

export function createAcpRegistryWireController(service: AcpRegistryService): Controller {
  return createController(acpRegistryContract, {
    search: ({ query, refresh }) => service.search(query, refresh === true),
    icon: ({ agentId }) => service.icon(agentId),
    previewRegistryAgent: ({ agentId, replacesProviderId }) =>
      service.preview(agentId, replacesProviderId),
    addRegistryAgent: (input) => service.addRegistry(input),
    addLocalAgent: (input) => service.addLocal(input),
    list: () => service.list(),
    probe: ({ providerId }) => service.probe(providerId),
    remove: ({ providerId }) => service.remove(providerId),
    setEnvSecret: ({ providerId, name, value }) => service.setEnvSecret(providerId, name, value),
  });
}
