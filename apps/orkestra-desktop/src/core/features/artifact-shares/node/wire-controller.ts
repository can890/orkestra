import { err, ok } from '@orkestra/shared';
import type { Scope } from '@orkestra/shared/concurrency';
import { createController, type Controller } from '@orkestra/wire/rpc';
import { artifactSharesContract } from '../api';
import type { ArtifactShareServer } from './artifact-share-server';

export function createArtifactSharesWireController(
  server: ArtifactShareServer,
  scope: Scope
): Controller {
  // Uygulama kapanırken tüm paylaşımlar biter ve port kapanır.
  scope.add(() => server.dispose());
  return createController(artifactSharesContract, {
    create: async (input) => {
      const files = input.files.map((file) => ({
        path: file.path,
        bytes: new Uint8Array(Buffer.from(file.base64, 'base64')),
      }));
      const result = await server.create({ name: input.name, entry: input.entry, files });
      return result.success ? ok(result.data) : err(result.error);
    },
    list: () => server.list(),
    revoke: ({ id }) => server.revoke(id),
  });
}
