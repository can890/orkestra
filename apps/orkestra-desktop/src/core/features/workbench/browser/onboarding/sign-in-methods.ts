import type { GitHubImportCliAccountsResponse } from '@core/primitives/github/api';

export const GITHUB_CLI_IMPORT_FAILED_MESSAGE = 'GitHub CLI hesapları içe aktarılamadı.';

/**
 * Orkestra hesabıyla giriş yalnızca hesap sunucusu sağlık denetimini geçtiğinde sunulur.
 * Sunucu yapılandırılmamışsa `checkHealth` ağa çıkmadan, ulaşılamıyorsa denetimden sonra `false`
 * döner. Yanıt gelene kadar (`undefined`) da giriş gizli kalır; böylece başarısız olacak bir
 * giriş düğmesi hiç gösterilmez.
 */
export function shouldOfferAccountSignIn(accountServerAvailable: boolean | undefined): boolean {
  return accountServerAvailable === true;
}

export type GitHubCliImportOutcome =
  | { kind: 'connected' }
  /** `gh` kurulu değil, oturum açılmamış ya da oturumdaki token doğrulanamadı. */
  | { kind: 'cli-unavailable' }
  | { kind: 'failed'; message: string };

export function classifyGitHubCliImport(
  result: GitHubImportCliAccountsResponse
): GitHubCliImportOutcome {
  if (!result.success) return { kind: 'failed', message: GITHUB_CLI_IMPORT_FAILED_MESSAGE };
  // İçe aktarma, `gh auth status` başarısız olduğunda ya da `gh` bulunamadığında boş döner.
  if (result.importedAccountIds.length === 0) return { kind: 'cli-unavailable' };
  return { kind: 'connected' };
}
