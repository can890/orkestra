import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const subagentRoutingDomain = 'subagentRouting' as const;

export type RoutingPreviewRow = {
  tierId: string;
  tierLabel: string;
  tierEnabled: boolean;
  provider: string;
  model: string;
  effort: string | null;
  enabled: boolean;
  state: 'ok' | 'low' | 'exhausted' | 'unknown';
  remainingPercent: number | null;
  windowLabel: string | null;
  resetsAt: string | null;
  /** Bu katman için şu an önerilen aday (model verilmeden çağrılırsa seçilecek olan). */
  recommended: boolean;
  /** Kıt model kalıbıyla eşleşiyor. */
  scarce: boolean;
};

export type RoutingPreview = {
  enabled: boolean;
  rows: RoutingPreviewRow[];
  /** Köprünün okuduğu anlık görüntü dosyası. */
  snapshotFile: string;
  /** Son yazım anı (epoch ms); ayar kapalıyken null. */
  writtenAt: number | null;
  lastError: string | null;
};

/** Ayarlar sayfasının canlı önizleme tablosu. */
export const subagentRoutingContract = defineContract({
  preview: procedure({
    input: z.object({ refresh: z.boolean().optional() }),
    output: z.custom<RoutingPreview>(),
  }),
});
