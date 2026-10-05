import type { LoadHistoryResult } from '@orkestra/core/runtimes/acp/api/client';
import type { AgentMetadata } from '@core/primitives/agents/api';

/** Etkinleştirme raporunun, oturumun sunmadığı için temizlenen seçimleri anlatan kısmı. */
export type ClearedSelectionReport = Pick<
  LoadHistoryResult,
  'clearedConfiguration' | 'clearedValues'
>;

/** Duyurulacak temizleme; model kimliği yalnızca anahtar gönderen eski çalışma zamanlarında null. */
export type ClearedModelNotice = { modelId: string | null };

export function clearedModelNoticeMessage(modelName: string | null): string {
  return modelName
    ? `Seçtiğiniz model (${modelName}) bu oturumda sunulmuyor; varsayılan model kullanılıyor.`
    : 'Seçtiğiniz model bu oturumda sunulmuyor; varsayılan model kullanılıyor.';
}

/** Sağlayıcı kataloğundaki görünen ad (ör. "Claude Opus 4.8"); katalogda yoksa ham kimlik. */
export function catalogModelName(
  agents: readonly AgentMetadata[],
  providerId: string,
  modelId: string
): string {
  const models = agents.find((agent) => agent.id === providerId)?.capabilities.models;
  if (models?.kind !== 'selectable' || !Object.hasOwn(models.modelOptions, modelId)) return modelId;
  return models.modelOptions[modelId]?.name || modelId;
}

/**
 * Temizlenen model seçimini her gerçek temizleme için bir kez duyurur. Çalışma zamanı temizlenen
 * seçimi, kullanıcı yeni bir değer seçene dek her etkinleştirme raporunda yeniden bildirir
 * (konuşma yeniden açıldığında, geçmiş yenilendiğinde); bunlar aynı temizlemedir. Modeli içermeyen
 * bir rapor temizlemenin kapandığını gösterir, ondan sonra gelen rapor yeni bir temizlemedir.
 * Durum bu pencere açık kaldıkça bellekte tutulur; konuşma sekmesi kapatılıp açılsa da korunur.
 */
export class ClearedModelNotices {
  private readonly announced = new Map<string, string | null>();

  /** Duyurulması gereken temizleme; bu temizleme zaten duyurulduysa undefined. */
  take(conversationId: string, report: ClearedSelectionReport): ClearedModelNotice | undefined {
    if (!report.clearedConfiguration?.includes('model')) {
      this.announced.delete(conversationId);
      return undefined;
    }
    const modelId = report.clearedValues?.model ?? null;
    if (this.announced.has(conversationId)) {
      const previous = this.announced.get(conversationId) ?? null;
      // Değeri bilinmeyen rapor, duyurulmuş temizlemeden ayırt edilemez.
      if (previous === null || modelId === null || previous === modelId) return undefined;
    }
    this.announced.set(conversationId, modelId);
    return { modelId };
  }
}

export const clearedModelNotices = new ClearedModelNotices();
