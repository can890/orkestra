// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/mobile/src/features/agent-awareness/notificationPayload.ts
// Bildirime dokunma hedefinin sıkı doğrulanması; T3'teki derin bağlantı yolu yerine yerel
// servisin verdiği `{hostId, conversationId}` JSON'u.

export type AgentNotificationTarget = { hostId: string; conversationId: string };

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

/** Yerel köprüden gelen hedefi doğrular; bozuk/eksik değerde `null`. */
export function parseLaunchTarget(raw: string | null | undefined): AgentNotificationTarget | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { hostId, conversationId } = value as Record<string, unknown>;
  if (typeof hostId !== 'string' || typeof conversationId !== 'string') return null;
  if (!ID_RE.test(hostId) || !ID_RE.test(conversationId)) return null;
  return { hostId, conversationId };
}
