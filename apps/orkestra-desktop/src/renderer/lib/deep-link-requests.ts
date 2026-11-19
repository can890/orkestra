import { toast } from '@orkestra/ui/react/primitives';
import { when } from 'mobx';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { DeepLinkTarget } from '@core/primitives/deep-links/api/deep-link';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { getDesktopWireClient } from './runtime/desktop-wire-client';

/**
 * `orkestra://` bağlantıları YALNIZCA gezinme yapar. Ana süreç kimliği çözüp
 * hedef verir; burada yalnızca ilgili görünüm açılır (komut, prompt, dosya
 * işlemi, ayar ya da ağ isteği yok). Bulunamayan kimlik küçük bir bildirimle söylenir.
 */
function openTarget(target: DeepLinkTarget): void {
  const navigation = getNavigation();
  switch (target.kind) {
    case 'project':
      navigation.navigate(projectViewDef({ projectId: target.projectId }));
      return;
    case 'task':
      navigation.navigate(taskViewDef({ projectId: target.projectId, taskId: target.taskId }));
      return;
    case 'conversation': {
      navigation.navigate(taskViewDef({ projectId: target.projectId, taskId: target.taskId }));
      const { projectId, taskId, conversationId } = target;
      when(
        () => !!getTaskComposition(projectId, taskId),
        () => {
          getTaskComposition(projectId, taskId)?.paneLayout.open(
            'conversation',
            { conversationId },
            { preview: false }
          );
        },
        { timeout: 10_000 }
      );
      return;
    }
    case 'not-found':
      toast('Bağlantı açılamadı', {
        description: 'Bu bağlantıdaki kayıt bu bilgisayarda bulunamadı.',
      });
      return;
  }
}

/**
 * @param navigationRestored Soğuk başlatmada kayıtlı gezinme geri yüklenmeden
 *   gezinmeyi yapmamak için beklenir (aksi halde geri yükleme bağlantıyı ezerdi).
 */
export function wireDeepLinkRequests(navigationRestored: Promise<unknown>): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const drain = async (): Promise<void> => {
    const client = await getDesktopWireClient();
    const targets = await client.host.takePendingDeepLinks();
    if (disposed) return;
    for (const target of targets) openTarget(target);
  };

  void (async () => {
    const client = await getDesktopWireClient();
    const nextUnsubscribe = await client.host.events.subscribe(undefined, {
      onEvent: (event) => {
        if (event.type === 'deep-link-pending') void navigationRestored.then(drain).catch(() => {});
      },
      onGap: () => {},
    });
    if (disposed) nextUnsubscribe();
    else unsubscribe = nextUnsubscribe;
    // Soğuk başlatma: olay abonelikten önce gelmiş olabilir; sırada bekleyeni al.
    await navigationRestored;
    await drain();
  })().catch(() => {});

  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
