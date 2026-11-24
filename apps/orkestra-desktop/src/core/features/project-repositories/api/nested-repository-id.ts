import { isSafeRelativeRepositoryPath } from './discovery';

// Çok depolu bir projede, bir görevin klasöründeki iç depoyu kaynak kontrolü sözleşmesinin
// `workspaceId` anahtarıyla adreslemek için bileşik kimlik. Kaynak kontrolü denetleyicisi bu
// kimliği çözerken göreli yolu diskteki keşif sonucuna karşı doğrular; böylece mevcut checkout
// canlı modeli, stage/commit/push işleri ve hunk okumaları hiçbir sözleşme değişikliği olmadan
// seçilen depo üzerinde çalışır.

const SEPARATOR = '::repo::';

export function nestedRepositoryWorkspaceId(workspaceId: string, relativePath: string): string {
  return `${workspaceId}${SEPARATOR}${relativePath}`;
}

export type ParsedNestedRepositoryWorkspaceId = Readonly<{
  workspaceId: string;
  relativePath: string;
}>;

/** Bileşik kimliği çözer; sıradan (iç depo içermeyen) kimlikler için `null` döner. */
export function parseNestedRepositoryWorkspaceId(
  id: string
): ParsedNestedRepositoryWorkspaceId | null {
  const index = id.indexOf(SEPARATOR);
  if (index <= 0) return null;
  const workspaceId = id.slice(0, index);
  const relativePath = id.slice(index + SEPARATOR.length);
  if (!isSafeRelativeRepositoryPath(relativePath)) return null;
  return { workspaceId, relativePath };
}
