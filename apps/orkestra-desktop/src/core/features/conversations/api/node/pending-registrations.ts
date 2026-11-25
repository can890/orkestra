// Ana-makine-önce (host-first) oluşturma akışında kayıt, masaüstü işlemi onu talep etmeden önce
// canlı eşitleme tarafından `adopted` olarak görülebilir (spec §6.2). Bu kısa pencerede
// otomatik bağlama (`autoLinkAdoptedConversations`) sohbet için ikinci, boş bir "hayalet" görev
// açıyordu. Bu kayıt defteri, masaüstünün kendisi tarafından oluşturulmakta olan sohbetleri
// işaretler; bağlama bu kimlikleri atlar. Süreç içi bellektir: yeniden başlatmada boşalır.

/** İşaret, talep (register) veya geri alma hiç gelmezse bu süreden sonra yok sayılır. */
const PENDING_TTL_MS = 2 * 60_000;

const pending = new Map<string, number>();

export function markConversationRegistrationPending(
  conversationId: string,
  now: number = Date.now()
): void {
  pending.set(conversationId, now);
}

export function clearConversationRegistrationPending(conversationId: string): void {
  pending.delete(conversationId);
}

export function isConversationRegistrationPending(
  conversationId: string,
  now: number = Date.now()
): boolean {
  const markedAt = pending.get(conversationId);
  if (markedAt === undefined) return false;
  if (now - markedAt > PENDING_TTL_MS) {
    pending.delete(conversationId);
    return false;
  }
  return true;
}

/** Masaüstünün şu an oluşturmakta olduğu (henüz talep edilmemiş) herhangi bir sohbet var mı? */
export function hasPendingConversationRegistrations(now: number = Date.now()): boolean {
  for (const conversationId of [...pending.keys()]) {
    if (isConversationRegistrationPending(conversationId, now)) return true;
  }
  return false;
}
