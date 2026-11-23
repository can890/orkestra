import { createController, type Controller } from '@orkestra/wire/rpc';
import { secretsContract } from '../api/contract';
import { OnePasswordResolver } from './onepassword-resolver';

export function createSecretsWireController(
  resolver: OnePasswordResolver = new OnePasswordResolver()
): Controller {
  return createController(secretsContract, {
    checkOnePasswordCli: (input) => resolver.checkCli(input?.account),
    resolvePreview: ({ reference, account }) => resolver.resolvePreview(reference, account),
  });
}
