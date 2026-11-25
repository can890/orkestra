import type { TasksWireClient } from './client';

type CleanupClient = Pick<TasksWireClient, 'cleanupGhostFreeChats'>;

export type GhostFreeChatCleanupScheduleOptions = {
  getClient(): Promise<CleanupClient>;
  /** O an açık olan görevler; her denemede yeniden okunur ve asla silinmez. */
  openTaskIds(): string[];
  /** İlk denemeden önceki bekleme: başlangıç eşitlemesinin oturmasına zaman tanır. */
  initialDelayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  wait?: (ms: number) => Promise<void>;
  onResult?: (result: Awaited<ReturnType<CleanupClient['cleanupGhostFreeChats']>>) => void;
  onError?: (error: unknown) => void;
};

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Açılışta boş "hayalet" serbest sohbet temizliğini bir kez ister. Ana süreç işi ertelerse
 * (yerel eşitleme ya da sürmekte olan bir sohbet kaydı) birkaç kez yeniden dener; kalıcı
 * bayrak ana süreçte tutulduğu için tamamlanan temizlik sonraki açılışlarda hemen döner.
 */
export async function scheduleGhostFreeChatCleanup(
  options: GhostFreeChatCleanupScheduleOptions
): Promise<void> {
  const wait = options.wait ?? defaultWait;
  const maxAttempts = options.maxAttempts ?? 3;
  await wait(options.initialDelayMs ?? 15_000);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const client = await options.getClient();
      const result = await client.cleanupGhostFreeChats({ openTaskIds: options.openTaskIds() });
      options.onResult?.(result);
      if (result.status !== 'deferred') return;
    } catch (error) {
      options.onError?.(error);
      return;
    }
    if (attempt < maxAttempts) await wait(options.retryDelayMs ?? 30_000);
  }
}
