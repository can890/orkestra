/**
 * "Sohbetler" (serbest sohbetler) listesinin sıralama modeli.
 *
 * Kural:
 * - Kullanıcının sürükleyerek yerleştirdiği sohbetler kalıcı bir elle sıra listesinde tutulur
 *   (`taskOrderByProject[FREE_CHAT_PROJECT_ID]`); etkinlik (yeni mesaj, ajan durumu) bu sırayı
 *   asla değiştirmez.
 * - Elle sırada henüz yer almayan sohbetler (yeni açılanlar ya da kullanıcı hiç sürüklemediyse
 *   tümü) listenin en üstünde, oluşturulma zamanına göre en yeni üstte olacak şekilde durur.
 *   Böylece yeni sohbet anında en üstte belirir ve oluşturulma zamanı değişmediği için yeri
 *   sabit kalır.
 * - Elle sırada olup artık listede bulunmayan kimlikler (silinen/arşivlenen/sabitlenen) yok sayılır.
 */

const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Zaman damgasını milisaniyeye çevirir. SQLite `CURRENT_TIMESTAMP` biçimi
 * (`2026-11-25 10:43:56`, saat dilimi yok, UTC) ile ISO biçimi karışık geldiği için metin
 * karşılaştırması yanlış sonuç verir (boşluk `T`'den küçük sıralanır); bu yüzden ikisi de UTC
 * olarak ayrıştırılır. Ayrıştırılamayan veya boş değerler 0 döner.
 */
export function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  const sqlite = SQLITE_TIMESTAMP.exec(trimmed);
  const parsed = Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type FreeChatOrderItem = Readonly<{ id: string; createdAt: string | null | undefined }>;

/** Yeni (elle sırada olmayan) sohbetleri en yeni üstte, eşitlikte kimliğe göre sıralar. */
function compareNewestFirst(a: FreeChatOrderItem, b: FreeChatOrderItem): number {
  const d = timestampMs(b.createdAt) - timestampMs(a.createdAt);
  if (d !== 0) return d;
  return a.id.localeCompare(b.id);
}

/** Öğeleri yukarıdaki kurala göre sıralar; girdi dizisini değiştirmez. */
export function orderFreeChats<T extends FreeChatOrderItem>(
  items: readonly T[],
  manualOrder: readonly string[] | undefined
): T[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const placed: T[] = [];
  const placedIds = new Set<string>();
  for (const id of manualOrder ?? []) {
    const item = byId.get(id);
    if (!item || placedIds.has(id)) continue;
    placed.push(item);
    placedIds.add(id);
  }
  const unplaced = items.filter((item) => !placedIds.has(item.id)).sort(compareNewestFirst);
  return [...unplaced, ...placed];
}

/**
 * `id`'yi görünür sıradaki `toIndex` konumuna taşır ve yeni tam sırayı döner.
 * Bilinmeyen kimlikte veya konum değişmiyorsa `null` döner. `toIndex` sınırlara kırpılır.
 */
export function moveFreeChat(
  orderedIds: readonly string[],
  id: string,
  toIndex: number
): string[] | null {
  const from = orderedIds.indexOf(id);
  if (from === -1) return null;
  const target = Math.max(0, Math.min(orderedIds.length - 1, Math.trunc(toIndex)));
  if (target === from) return null;
  const next = [...orderedIds];
  next.splice(from, 1);
  next.splice(target, 0, id);
  return next;
}

/** Klavye ile bir adım yukarı (-1) veya aşağı (+1) taşıma; kenarlarda `null` döner. */
export function moveFreeChatBy(
  orderedIds: readonly string[],
  id: string,
  delta: -1 | 1
): string[] | null {
  const from = orderedIds.indexOf(id);
  if (from === -1) return null;
  const target = from + delta;
  if (target < 0 || target >= orderedIds.length) return null;
  return moveFreeChat(orderedIds, id, target);
}

/**
 * Sürükle-bırak sonucu: `overId` satırının üstüne (`placeAbove`) veya altına bırakılan
 * `activeId`'nin yeni sırası. Geçersiz bırakmada veya konum değişmiyorsa `null`.
 */
export function dropFreeChat(
  orderedIds: readonly string[],
  activeId: string,
  overId: string,
  placeAbove: boolean
): string[] | null {
  if (activeId === overId) return null;
  const from = orderedIds.indexOf(activeId);
  const over = orderedIds.indexOf(overId);
  if (from === -1 || over === -1) return null;
  let target = placeAbove ? over : over + 1;
  if (target > from) target -= 1;
  return moveFreeChat(orderedIds, activeId, target);
}
