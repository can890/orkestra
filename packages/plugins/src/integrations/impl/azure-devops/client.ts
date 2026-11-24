import { err, ok, type Result } from '@orkestra/shared';
import { parseCredentials } from '../../helpers/credentials';
import {
  basicAuthorization,
  createHttpClient,
  type FetchLike,
  type HttpClient,
  isHeaderSafe,
} from '../../helpers/http-client';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import { AZURE_DEVOPS_HOST, organizationFromUrl } from './remote';
import {
  type AzureDevOpsCredentials,
  azureDevOpsConnectionDataSchema,
  azureDevOpsCredentialsSchema,
  type AzureDevOpsVerifiedConnection,
} from './types';

/** Azure DevOps REST sürümü; önizleme gerektiren uç noktalar kendi sürümünü verir. */
export const AZURE_DEVOPS_API_VERSION = '7.1';

export type AzureDevOpsClientOptions = {
  fetch?: FetchLike;
};

export function readAzureDevOpsCredentials(
  credentials: IntegrationCredentials
): Result<AzureDevOpsCredentials, IntegrationError> {
  return parseCredentials(azureDevOpsCredentialsSchema, credentials);
}

/** Kişisel erişim anahtarı Basic kimlik doğrulamada boş kullanıcı adıyla gönderilir. */
export function azureDevOpsAuthorization(
  credentials: AzureDevOpsCredentials
): Result<string, IntegrationError> {
  if (!isHeaderSafe(credentials.personalAccessToken)) {
    return err({
      type: 'invalid_input',
      message: 'The Azure DevOps personal access token contains unsupported characters.',
    });
  }
  return ok(basicAuthorization('', credentials.personalAccessToken));
}

/** İstemcinin kökü kuruluş adresidir (`https://dev.azure.com/{org}`). */
export function createAzureDevOpsClient(
  credentials: AzureDevOpsCredentials,
  options: AzureDevOpsClientOptions = {}
): Result<HttpClient, IntegrationError> {
  const authorization = azureDevOpsAuthorization(credentials);
  if (!authorization.success) return authorization;
  return ok(
    createHttpClient({
      provider: 'Azure DevOps',
      baseUrl: credentials.organizationUrl,
      authorization: authorization.data,
      fetch: options.fetch,
      // Geçersiz PAT çoğu zaman 401 yerine 203 + HTML giriş sayfası döndürür.
      treatNonJsonAsAuthFailure: true,
      headers: { 'X-TFS-FedAuthRedirect': 'Suppress' },
    })
  );
}

export async function verifyAzureDevOpsCredentials(
  rawCredentials: IntegrationCredentials,
  options: AzureDevOpsClientOptions = {}
): Promise<Result<AzureDevOpsVerifiedConnection, IntegrationError>> {
  const credentials = readAzureDevOpsCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);
  const client = createAzureDevOpsClient(credentials.data, options);
  if (!client.success) return err(client.error);

  // connectionData kimliği verir ama kuruluş yetkisini kanıtlamaz; projeler listesi kanıtlar.
  const [connection, projects] = await Promise.all([
    client.data.request({ path: '/_apis/connectionData' }),
    client.data.request({
      path: '/_apis/projects',
      query: { $top: 1, 'api-version': AZURE_DEVOPS_API_VERSION },
    }),
  ]);
  if (!projects.success) return err(projects.error);
  if (!connection.success) return err(connection.error);

  const parsed = azureDevOpsConnectionDataSchema.safeParse(connection.data.body);
  const user = parsed.success ? parsed.data.authenticatedUser : null;
  const id = user?.id ?? undefined;
  const login = user?.properties?.Account?.$value ?? undefined;
  const displayName = user?.customDisplayName ?? user?.providerDisplayName ?? login ?? undefined;
  const organization = organizationFromUrl(credentials.data.organizationUrl);
  const displayDetail = organization ? `${AZURE_DEVOPS_HOST}/${organization}` : AZURE_DEVOPS_HOST;

  return ok({
    ...(id
      ? {
          account: {
            id,
            ...(login ? { login } : {}),
            host: AZURE_DEVOPS_HOST,
            // Aynı kullanıcı farklı kuruluşlarda ayrı hesaplardır.
            scope: credentials.data.organizationUrl,
          },
        }
      : {}),
    ...(displayName ? { displayName } : {}),
    displayDetail,
    credentials: credentials.data,
  });
}
