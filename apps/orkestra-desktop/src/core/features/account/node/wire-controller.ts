import type { Logger } from '@orkestra/shared/logger';
import { createController, type Controller } from '@orkestra/wire/rpc';
import type { TelemetryService } from '@core/primitives/telemetry/api/telemetry';
import { accountContract } from '../api';
import type { OrkestraAccountService } from './services/orkestra-account-service';

type AccountControllerDependencies = {
  logger: Logger;
  telemetry: TelemetryService;
};

export function createAccountWireController(
  service: OrkestraAccountService,
  dependencies: AccountControllerDependencies
): Controller {
  return createController(accountContract, {
    getSession: () => getSession(service, dependencies.logger),
    signIn: ({ provider }) => signIn(service, dependencies, provider),
    linkProviderAccount: ({ provider }) => linkProviderAccount(service, dependencies, provider),
    signOut: () => signOut(service, dependencies),
    checkHealth: () => service.checkServerHealth(),
  });
}

async function getSession(service: OrkestraAccountService, logger: Logger) {
  const result = await service.getSession();
  if (!result.success) {
    logger.error('Failed to get account session', { error: result.error });
    return { user: null, isSignedIn: false, hasAccount: false };
  }
  return result.data;
}

async function signIn(
  service: OrkestraAccountService,
  dependencies: AccountControllerDependencies,
  provider?: string
) {
  const result = await service.signIn(provider);
  if (!result.success) {
    dependencies.logger.error('Account sign-in failed', { error: result.error });
    return {
      success: false,
      code: result.error.type,
      error: result.error.message,
    };
  }

  dependencies.telemetry.capture('user_signed_in');
  return { success: true, user: result.data.user };
}

async function linkProviderAccount(
  service: OrkestraAccountService,
  dependencies: AccountControllerDependencies,
  provider?: string
) {
  const result = await service.linkProviderAccount(provider);
  if (!result.success) {
    if (result.error.type !== 'session_expired') {
      dependencies.logger.error('Provider account link failed', { error: result.error });
    }
    return {
      success: false,
      code: result.error.type,
      error: result.error.message,
    };
  }

  dependencies.telemetry.capture('integration_connected', { provider: result.data.provider });
  return {
    success: true,
    provider: result.data.provider,
    providerAccountStatus: result.data.providerAccountStatus,
    providerAccount: result.data.providerAccount,
  };
}

async function signOut(
  service: OrkestraAccountService,
  dependencies: AccountControllerDependencies
) {
  const result = await service.signOut();
  if (!result.success) {
    dependencies.logger.error('Account sign-out failed', { error: result.error });
    return { success: false, code: result.error.type, error: result.error.message };
  }

  dependencies.telemetry.capture('user_signed_out');
  return { success: true };
}
