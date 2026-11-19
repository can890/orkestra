import { getProjectMemoryClient } from '@core/features/project-memory/api/browser/client';
import { log } from '@core/primitives/logging/browser/logger';

/**
 * Sohbetin ilk mesajına, projenin ortak hafıza dizinini (yalnızca ad + tek satır açıklama,
 * "talimat değil geçmiş not" çerçevesiyle) gizli bağlam olarak ekler. Proje ayarı kapalıysa,
 * kayıt yoksa ya da okunamazsa mevcut bağlam aynen döner.
 */
export async function withProjectMemoryContext(
  projectId: string,
  existing: string | Promise<string | undefined> | undefined
): Promise<string | undefined> {
  const [base, memory] = await Promise.all([
    existing,
    getProjectMemoryClient()
      .then((client) => client.promptContext({ projectId }))
      .catch((error: unknown) => {
        log.warn('Proje hafızası bağlamı okunamadı', { projectId, error: String(error) });
        return null;
      }),
  ]);
  const parts = [memory, base].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
