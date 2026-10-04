import type { FsError } from '@orkestra/core/runtimes/files/api';
import { fsErrorMessage } from '@core/services/runtime-broker/node/files';

export function fileErrorToMessage(error: FsError): string {
  return fsErrorMessage(error);
}
