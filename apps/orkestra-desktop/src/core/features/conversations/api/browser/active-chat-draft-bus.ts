export type ChatDraftImagePayload = {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
};

export type ChatDraftInjection = {
  text?: string;
  image?: ChatDraftImagePayload;
  files?: File[];
};

type ChatDraftHandler = (payload: ChatDraftInjection) => Promise<void> | void;

const registeredHandlers = new Map<string, ChatDraftHandler>();
const registrationOrder: string[] = [];
let focusedConversationId: string | null = null;

/**
 * Aktif sohbet taslağına harici araçlardan (Önizleme Öğe Seçici, Global SnapShot, Yan Sohbet)
 * metin ve görsel eklemek için handler kaydeder.
 */
export function registerActiveChatDraftHandler(
  conversationId: string,
  handler: ChatDraftHandler
): () => void {
  registeredHandlers.set(conversationId, handler);
  const existingIdx = registrationOrder.indexOf(conversationId);
  if (existingIdx >= 0) registrationOrder.splice(existingIdx, 1);
  registrationOrder.push(conversationId);
  focusedConversationId = conversationId;

  return () => {
    if (registeredHandlers.get(conversationId) === handler) {
      registeredHandlers.delete(conversationId);
    }
    const idx = registrationOrder.indexOf(conversationId);
    if (idx >= 0) registrationOrder.splice(idx, 1);
    if (focusedConversationId === conversationId) {
      focusedConversationId = registrationOrder[registrationOrder.length - 1] ?? null;
    }
  };
}

export function setFocusedChatConversation(conversationId: string | null): void {
  if (conversationId && registeredHandlers.has(conversationId)) {
    focusedConversationId = conversationId;
  } else if (!conversationId) {
    focusedConversationId = registrationOrder[registrationOrder.length - 1] ?? null;
  }
}

export function hasActiveChatDraftTarget(): boolean {
  return (
    (focusedConversationId !== null && registeredHandlers.has(focusedConversationId)) ||
    registrationOrder.some((id) => registeredHandlers.has(id))
  );
}

export async function injectIntoActiveChatDraft(payload: ChatDraftInjection): Promise<boolean> {
  const targetId =
    focusedConversationId && registeredHandlers.has(focusedConversationId)
      ? focusedConversationId
      : registrationOrder[registrationOrder.length - 1];
  if (!targetId) return false;
  const handler = registeredHandlers.get(targetId);
  if (!handler) return false;
  await handler(payload);
  return true;
}

export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').trim();
  const binary = atob(clean);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
