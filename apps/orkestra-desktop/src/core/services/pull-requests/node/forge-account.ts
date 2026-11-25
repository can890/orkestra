import { organizationFromUrl } from '@orkestra/plugins/integrations/forge';
import type { Resolved } from '@core/primitives/project-settings/api/effective-settings';
import { parseForgeRepositoryRef } from '@core/primitives/repository/api';

type Account = { accountId: string };

/**
 * Azure DevOps hesapları ana makineyle değil kuruluşla ayrışır: aynı `dev.azure.com` altında
 * birden çok kuruluş hesabı olabilir ve ana makine eşleştirmesi varsayılanı (ya da hiçbirini)
 * seçer. Proje hiçbir seçim yapmamışsa (`inferred`), deponun kuruluşuyla eşleşen tek hesap seçilir.
 * Kullanıcının bir şey seçtiğini gösteren her köken asla değiştirilmez: sabitlenmiş ya da
 * kapatılmış (`set`), silinmiş/ana makinesi uyuşmayan sabit (`unresolvable`) ve bozuk ayar
 * (`broken-setting`). Son ikisi `null` olarak kalır ve çağıran taraf başka bir kimliğe geçmek
 * yerine kapalı hata verir. Eşleşme yoksa çözümleyicinin sonucu kalır ve istemci kuruluş
 * uyuşmazlığını açık bir hatayla bildirir.
 */
export async function selectForgeAccountForRepository<A extends Account>(
  repositoryUrl: string,
  resolution: Resolved<A | null> & { accounts: A[] },
  readOrganizationUrl: (accountId: string) => Promise<string | null>
): Promise<A | null> {
  const forge = parseForgeRepositoryRef(repositoryUrl);
  if (forge?.provider !== 'azure-devops' || resolution.provenance.kind !== 'inferred') {
    return resolution.value;
  }
  const organization = organizationFromUrl(forge.repositoryUrl)?.toLowerCase();
  if (!organization) return resolution.value;
  const matches: A[] = [];
  for (const account of resolution.accounts) {
    const organizationUrl = await readOrganizationUrl(account.accountId);
    if (organizationUrl && organizationFromUrl(organizationUrl)?.toLowerCase() === organization) {
      matches.push(account);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : resolution.value;
}
