/** Format an epoch-ms timestamp cleanly as HH:mm for message footers. */
export function formatMessageTime(createdAt?: number): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  try {
    return new Date(createdAt).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}
