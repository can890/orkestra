import type { SidebarSectionId } from '@core/features/workbench/browser/sidebar/sidebar-store';

/**
 * Eski sürümlerin kenar çubuğu bölümlerinin açık/kapalı durumunu yazdığı localStorage anahtarları.
 * Bu durum artık `workbenchSidebarMemento` içinde tutulur; anahtarlar yalnızca bir kerelik
 * taşıma için okunur, taşıma kalıcılaştıktan sonra silinir.
 */
export const LEGACY_SIDEBAR_SECTION_OPEN_KEYS: Readonly<
  Record<'freeChats' | 'externalSessions' | 'settled', string>
> = {
  freeChats: 'orkestra:sidebar-free-chats-open',
  externalSessions: 'orkestra:sidebar-external-sessions-open',
  settled: 'orkestra:sidebar-settled-open',
};

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;

interface SidebarSectionOpenTarget {
  adoptLegacySectionOpen(legacy: Partial<Record<SidebarSectionId, boolean>>): SidebarSectionId[];
}

/** Eski değerleri okur; yalnızca tam olarak 'true'/'false' olanlar geçerli sayılır. */
export function readLegacySidebarSectionOpen(
  storage: LegacyStorage
): Partial<Record<SidebarSectionId, boolean>> {
  const result: Partial<Record<SidebarSectionId, boolean>> = {};
  for (const [section, key] of Object.entries(LEGACY_SIDEBAR_SECTION_OPEN_KEYS) as [
    SidebarSectionId,
    string,
  ][]) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      // Depolama erişimi kısıtlıysa bu bölüm varsayılanında kalır.
    }
    if (raw === 'true') result[section] = true;
    else if (raw === 'false') result[section] = false;
  }
  return result;
}

/**
 * Bir kerelik taşıma: memento'da henüz değeri olmayan bölümler için eski değeri benimser,
 * memento diske yazıldıktan sonra eski anahtarları siler. Tekrar çağrılması zararsızdır:
 * anahtarlar yoksa hiçbir şey yapmaz, memento'da değer varsa eski değer onu ezmez.
 */
export async function migrateLegacySidebarSectionOpen(
  target: SidebarSectionOpenTarget,
  storage: LegacyStorage,
  flush: () => Promise<void>
): Promise<SidebarSectionId[]> {
  const legacy = readLegacySidebarSectionOpen(storage);
  if (Object.keys(legacy).length === 0) return [];
  const adopted = target.adoptLegacySectionOpen(legacy);
  if (adopted.length > 0) await flush();
  for (const key of Object.values(LEGACY_SIDEBAR_SECTION_OPEN_KEYS)) {
    try {
      storage.removeItem(key);
    } catch {
      // Silinemezse sorun değil: memento değeri artık önceliklidir.
    }
  }
  return adopted;
}
