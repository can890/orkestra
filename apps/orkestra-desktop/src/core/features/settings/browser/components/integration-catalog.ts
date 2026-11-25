/**
 * Ayarlar → Entegrasyonlar sayfasındaki sağlayıcı kataloğunun görünürlük ve gruplama kuralı.
 *
 * - Bağlı hesabı olan her sağlayıcı "bağlı" grubunda görünür (bağlantısı kesilebilsin diye).
 * - Bağlı olmayanlar yalnızca bu derlemede gerçekten bağlanabiliyorsa (`canConnect`) listelenir;
 *   böylece istemci uygulaması (OAuth app) olmayan sağlayıcılar ölü giriş olarak görünmez.
 * - Kaynak kontrol sağlayıcıları (depo remote'u üzerinden çalışanlar) görev takip araçlarından
 *   ayrı gruplanır.
 */

/** Depo barındıran sağlayıcılar; sıra katalogdaki gösterim sırasıdır. */
export const SOURCE_CONTROL_INTEGRATION_IDS: readonly string[] = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'forgejo',
];

type CatalogEntry = { id: string; isConfigured: boolean; canConnect: boolean };

export type IntegrationCatalog<T extends CatalogEntry> = {
  connected: T[];
  sourceControl: T[];
  issueTracking: T[];
};

export function groupIntegrationCatalog<T extends CatalogEntry>(
  integrations: readonly T[]
): IntegrationCatalog<T> {
  const available = integrations.filter(
    (integration) => !integration.isConfigured && integration.canConnect
  );
  const sourceControlOrder = (integration: T) =>
    SOURCE_CONTROL_INTEGRATION_IDS.indexOf(integration.id);
  return {
    connected: integrations.filter((integration) => integration.isConfigured),
    sourceControl: available
      .filter((integration) => sourceControlOrder(integration) >= 0)
      .sort((a, b) => sourceControlOrder(a) - sourceControlOrder(b)),
    issueTracking: available.filter((integration) => sourceControlOrder(integration) < 0),
  };
}
