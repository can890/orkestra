import { and, count, eq } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import type { AppSettingsService } from '@core/services/settings/node/app-settings-service';
import type { AgentStatusService } from '@main/core/agent-status/agent-status-service';
import { log } from '@main/lib/logger';
import { createKeepAwakeController, type PowerBlockerPort } from './keep-awake-controller';

/** Silinen bir sohbet olay üretmeden kaybolabilir; engel tutulurken sayım bu aralıkla tazelenir. */
const RECONCILE_INTERVAL_MS = 60_000;

export async function countWorkingConversations(db: AppDb): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(conversations)
    .where(and(liveConversations(), eq(conversations.agentStatus, 'working')));
  return row?.value ?? 0;
}

export interface KeepAwakeServiceDeps {
  settings: Pick<AppSettingsService, 'get' | 'on' | 'off'>;
  agentStatus: Pick<AgentStatusService, 'on'>;
  countWorking: () => Promise<number>;
  blocker: PowerBlockerPort;
}

/**
 * Ayarı ve çalışan sohbet sayısını denetleyiciye bağlar. Dönen işlev her şeyi
 * bırakır (dinleyiciler, zamanlayıcı, powerSaveBlocker); uygulama kapanırken çağrılır.
 */
export function startKeepAwakeService(deps: KeepAwakeServiceDeps): () => void {
  const controller = createKeepAwakeController(deps.blocker);
  let disposed = false;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let countTicket = 0;

  const refreshCount = async (): Promise<void> => {
    const ticket = ++countTicket;
    try {
      const count = await deps.countWorking();
      // Eski bir sayımın sonucu daha yeni olanı ezmesin.
      if (!disposed && ticket === countTicket) controller.setWorkingCount(count);
    } catch (error) {
      log.warn('keep-awake: failed to count working conversations', { error });
    } finally {
      scheduleReconcile();
    }
  };

  const refreshEnabled = async (): Promise<void> => {
    try {
      const { keepAwakeWhileWorking } = await deps.settings.get('power');
      if (!disposed) controller.setEnabled(keepAwakeWhileWorking);
    } catch (error) {
      // Okunamayan ayar "kapalı" demektir: güvenli taraf engeli bırakmaktır.
      log.warn('keep-awake: failed to read the power setting', { error });
      if (!disposed) controller.setEnabled(false);
    }
  };

  function scheduleReconcile(): void {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = undefined;
    if (disposed || !controller.isHeld) return;
    reconcileTimer = setTimeout(() => void refreshCount(), RECONCILE_INTERVAL_MS);
    reconcileTimer.unref();
  }

  const onSettingsChanged = (key: string): void => {
    if (key === 'power') void refreshEnabled().then(() => refreshCount());
  };
  deps.settings.on('app-settings:changed', onSettingsChanged);
  const unsubscribeStatus = deps.agentStatus.on('status:changed', () => void refreshCount());

  void refreshEnabled().then(() => refreshCount());

  return () => {
    if (disposed) return;
    disposed = true;
    deps.settings.off('app-settings:changed', onSettingsChanged);
    unsubscribeStatus();
    if (reconcileTimer) clearTimeout(reconcileTimer);
    controller.dispose();
  };
}
