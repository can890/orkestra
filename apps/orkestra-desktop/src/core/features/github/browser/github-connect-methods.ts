import type { IntegrationProviderDescriptor } from '@core/features/integrations/api/contract';

type AuthMethod = IntegrationProviderDescriptor['auth']['methods'][number];

export type GitHubConnectMethods = {
  cli: boolean;
  oauth: boolean;
  deviceFlow: boolean;
};

export const GITHUB_CLI_MISSING_MESSAGE =
  'GitHub CLI oturumu bulunamadı. GitHub CLI kurulu değilse cli.github.com adresinden kurun, ' +
  'terminalde "gh auth login" komutunu çalıştırın ve ardından tekrar deneyin.';

/**
 * Yalnızca gerçekten çalışabilecek bağlantı yollarını gösterir. Orkestra hesabıyla giriş, hesap
 * sunucusu sağlık denetimini geçtiğinde; device flow, bir GitHub OAuth istemci kimliği
 * tanımlandığında sunulur. Aksi hâlde bu kartlar her seferinde hata veriyordu.
 */
export function visibleGitHubConnectMethods(input: {
  methods: readonly AuthMethod[];
  accountServerAvailable: boolean | undefined;
  hasAccount: boolean;
}): GitHubConnectMethods {
  const has = (kind: AuthMethod['kind']) => input.methods.some((method) => method.kind === kind);
  return {
    cli: has('cli-import'),
    oauth: has('oauth') && input.accountServerAvailable === true,
    deviceFlow:
      !input.hasAccount &&
      input.methods.some(
        (method) => method.kind === 'oauth-device' && method.clientId.trim().length > 0
      ),
  };
}
