import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import type { ContractClient } from '@orkestra/wire/rpc';
import type { fsWatchContract } from '#services/fs-watch/api';
import { processWatchBackend } from '#services/fs-watch/impl/process-backend';
import { createWatchService } from '#services/fs-watch/impl/watch-service';

export function createProcessWatchServiceFromDependency({
  client,
  logger,
  scope,
}: {
  client: ContractClient<typeof fsWatchContract>;
  logger: Logger;
  scope: Scope;
}) {
  const onError = (context: string, error: unknown): void => logger.warn(context, { error });
  return createWatchService({
    backend: processWatchBackend({
      client,
      onError,
    }),
    scope,
    onError,
  });
}
