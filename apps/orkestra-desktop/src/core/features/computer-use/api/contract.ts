import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const computerUseDomain = 'computerUse' as const;

/** Etkinlik günlüğünde bir ajan eylemi; yazılan metnin kendisi asla tutulmaz. */
export type ComputerUseLogEntry = {
  /** Unix ms. */
  at: number;
  conversationId: string;
  tool: string;
  /** Koordinatlar, tuş adı ya da metin uzunluğu gibi içeriksiz özet. */
  summary: string;
  outcome: 'ok' | 'error' | 'denied';
};

export type ComputerUsePermissions = {
  /** Fare ve klavye olayı göndermek için gerekli (Erişilebilirlik). */
  accessibility: boolean;
  /** Ekran görüntüsü için gerekli (Ekran Kaydı). */
  screenRecording: boolean;
};

export type ComputerUseState = {
  /** Yalnızca macOS destekler; diğer platformlarda arayüz hiçbir şey göstermez. */
  supported: boolean;
  /** Genel ayar ("computerUse.enabled"). */
  globalEnabled: boolean;
  /** Bu sohbette kullanıcı açıkça etkinleştirdi mi (yalnızca bellekte, yeniden başlatmada sıfırlanır). */
  conversationEnabled: boolean;
  permissions: ComputerUsePermissions;
  /** Bu sohbetin son eylemleri, en yenisi sonda. */
  activity: ComputerUseLogEntry[];
};

export type ComputerUseResult = { success: true } | { success: false; error: string };

export type ComputerUsePermissionPane = 'accessibility' | 'screen-recording';

export const computerUseContract = defineContract({
  getState: procedure({
    input: z.object({ conversationId: z.string().min(1) }),
    output: z.custom<ComputerUseState>(),
  }),
  /**
   * Yalnızca arayüzdeki açık kullanıcı eylemi: sohbeti etkinleştirir. Ajan araçları ve MCP
   * çağrıları bu yola erişemez; genel ayar kapalıyken reddedilir.
   */
  setConversationEnabled: procedure({
    input: z.object({ conversationId: z.string().min(1), enabled: z.boolean() }),
    output: z.custom<ComputerUseResult>(),
  }),
  /** Tek tıkla durdurma: sohbetin kilidini kapatır, araçlar anında hata döndürür. */
  stop: procedure({
    input: z.object({ conversationId: z.string().min(1) }),
    output: z.custom<ComputerUseResult>(),
  }),
  /** Sistem Ayarları'nın ilgili bölümünü açar; izin istemini tetiklemez. */
  openPermissionSettings: procedure({
    input: z.object({ pane: z.enum(['accessibility', 'screen-recording']) }),
    output: z.custom<ComputerUseResult>(),
  }),
});
