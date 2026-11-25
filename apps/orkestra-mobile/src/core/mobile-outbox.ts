import type { PendingPrompt } from './conversation-session';

export type OutboxScope = {
  deviceId: string;
  hostId: string;
  conversationId: string;
};

export type MobileImage = {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
};

export type ComposerDraft = { text: string; attachments: MobileImage[] };

type Snapshot = { draft: ComposerDraft; pending: PendingPrompt[] };

const PREFIX = 'orkestra.mobile-outbox.v1:';
const locks = new Set<string>();

export function outboxKey(scope: OutboxScope): string {
  return PREFIX + JSON.stringify([scope.deviceId, scope.hostId, scope.conversationId]);
}

function read(key: string): Snapshot {
  const raw = globalThis.localStorage?.getItem(key);
  return raw
    ? (JSON.parse(raw) as Snapshot)
    : { draft: { text: '', attachments: [] }, pending: [] };
}

export function readOutbox(scope: OutboxScope): Snapshot {
  return read(outboxKey(scope));
}

export function updateOutbox(scope: OutboxScope, update: (value: Snapshot) => Snapshot): Snapshot {
  const key = outboxKey(scope);
  const next = update(read(key));
  if (next.pending.length || next.draft.text || next.draft.attachments.length) {
    globalThis.localStorage.setItem(key, JSON.stringify(next));
  } else {
    globalThis.localStorage.removeItem(key);
  }
  return next;
}

export function pendingChats(deviceId: string, hostId: string): string[] {
  const storage = globalThis.localStorage;
  if (!storage) return [];
  const prefix = PREFIX + JSON.stringify([deviceId, hostId]).slice(0, -1) + ',';
  const conversations: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    if (read(key).pending.some((item) => item.state === 'waiting' || item.state === 'sending')) {
      const [, , conversationId] = JSON.parse(key.slice(PREFIX.length)) as [string, string, string];
      conversations.push(conversationId);
    }
  }
  return conversations;
}

export function claimOutbox(scope: OutboxScope | undefined): (() => void) | null {
  if (!scope) return () => {};
  const key = outboxKey(scope);
  if (locks.has(key)) return null;
  locks.add(key);
  return () => locks.delete(key);
}

export async function readMobileImage(file: File): Promise<MobileImage> {
  const mimeType = file.type;
  if (
    mimeType !== 'image/png' &&
    mimeType !== 'image/jpeg' &&
    mimeType !== 'image/gif' &&
    mimeType !== 'image/webp'
  ) {
    throw new Error('PNG, JPEG, GIF veya WebP biçiminde bir görsel seçin.');
  }
  if (file.size === 0 || file.size > 256 * 1024) {
    throw new Error('Her görsel en fazla 256 KB olabilir.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const name = file.name.replaceAll(/[/\\\u0000-\u001f]/gu, '_').slice(0, 120) || 'Görsel';
  return { name, mimeType, data: btoa(binary) };
}
