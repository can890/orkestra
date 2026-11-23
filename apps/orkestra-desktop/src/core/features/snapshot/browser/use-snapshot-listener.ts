import { toast } from '@orkestra/ui/react/primitives';
import { useEffect } from 'react';
import {
  hasActiveChatDraftTarget,
  injectIntoActiveChatDraft,
} from '@core/features/conversations/api/browser/active-chat-draft-bus';
import { getSnapshotClient } from '@core/features/snapshot/api/browser/client';

export function useSnapshotListener(): void {
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void getSnapshotClient().then(async (client) => {
      const nextUnsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          const contextParts = [event.appName, event.windowTitle].filter(Boolean);
          const caption =
            contextParts.length > 0
              ? `[SnapShot · ${contextParts.join(' — ')}]`
              : '[SnapShot ekran görüntüsü]';

          if (hasActiveChatDraftTarget()) {
            void injectIntoActiveChatDraft({
              text: caption,
              image: {
                name: `snapshot-${event.createdAt}.png`,
                mimeType: event.mimeType,
                base64: event.base64,
              },
            }).then((sent) => {
              if (sent) {
                toast.success('SnapShot aktif sohbete eklendi', {
                  description: contextParts.join(' — ') || undefined,
                });
              }
            });
            return;
          }

          void navigator.clipboard?.writeText(caption).catch(() => undefined);
          toast('SnapShot yakalandı', {
            description:
              'Açık bir sohbet sekmesi bulunamadığı için pencere bilgisi panoya kopyalandı. Bir sohbet açıp tekrar deneyin.',
          });
        },
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
}
