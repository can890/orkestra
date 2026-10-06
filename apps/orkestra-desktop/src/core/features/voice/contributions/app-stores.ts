import { err, ok } from '@orkestra/shared';
import { toast } from '@orkestra/ui/react/primitives';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getVoiceClient } from '@core/features/voice/api/browser/client';
import { SpokenRepliesStore } from '@core/features/voice/browser/spoken-replies-store';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';

// Sesli yanıt deposunun uygulama kapsamına katkısı.

const spokenRepliesToken = scopedStoreToken<SpokenRepliesStore>('voice.spokenReplies');
const SYNTHESIZE_TIMEOUT_MS = 60_000;

function createSpokenRepliesStore(): SpokenRepliesStore {
  return new SpokenRepliesStore({
    synthesize: async (text, signal) => {
      try {
        const client = await getVoiceClient();
        const result = await client.synthesize(
          { text },
          { signal, timeoutMs: SYNTHESIZE_TIMEOUT_MS }
        );
        if (!result.success) return result;
        const bytes = await result.data.bytes();
        // Paylaşılan bellek ihtimaline karşı bağımsız bir ArrayBuffer'a kopyalanır.
        const buffer = new Uint8Array(bytes).buffer;
        return ok(new Blob([buffer], { type: result.data.meta.mimeType || 'audio/mpeg' }));
      } catch (error) {
        return err({
          type: 'network' as const,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    createAudio: () => new Audio(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    onError: (message, needsSettings) => {
      toast.error('Sesli yanıt okunamadı', {
        description: message,
        action: needsSettings
          ? {
              label: 'Ses ayarları',
              onClick: () => getNavigation().navigate(settingsViewDef({ tab: 'voice' })),
            }
          : undefined,
      });
    },
  });
}

export const voiceAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: spokenRepliesToken,
    create: () => createSpokenRepliesStore(),
    dispose: (store) => store.dispose(),
  }),
];

export function getSpokenRepliesStore(): SpokenRepliesStore {
  return getAppStores().get(spokenRepliesToken);
}
