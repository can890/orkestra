import { defineContract, eventStream, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

/**
 * Eşleşmiş telefonlara açılan "ajan etkinliği" akışı. Telefonun arka plan bildirim servisi bunu
 * okuyarak ajan turu bitince, hata verince, onay beklerken ya da soru sorunca bildirim gösterir ve
 * süren işleri tek bir "çalışan ajanlar" kartında özetler.
 *
 * Bu domain yalnızca uzak (mobil) yüzeye açılır; masaüstü renderer'ı kullanmaz. Yük bilerek
 * küçüktür: sohbet içeriği değil yalnızca başlık, proje, durum ve kısa bir önizleme taşır.
 * Akış yalnızca kullanıcının kendi makineleri arasında (uzak erişim kanalı üzerinden) dolaşır;
 * bulut/push servisi yoktur.
 */

export const agentActivityDomain = 'agentActivity' as const;

/** Tek snapshot'ta en çok bu kadar sohbet taşınır (önce süren işler, sonra en yeni sonuçlar). */
export const AGENT_ACTIVITY_MAX_ENTRIES = 40;
/** Önizleme metni üst sınırı (karakter). */
export const AGENT_ACTIVITY_PREVIEW_CHARS = 240;
/** Başlık/proje/sağlayıcı adı üst sınırı (karakter). */
export const AGENT_ACTIVITY_LABEL_CHARS = 120;
/** Biten/başarısız sonuçlar host'ta bu süre tutulur; telefon kartında 15 dk gösterilir. */
export const AGENT_ACTIVITY_SETTLED_RETENTION_MS = 30 * 60_000;
/** Snapshot için bayt bütçesi; uzak çerçeve sınırının (`REMOTE_HISTORY_MAX_BYTES`) çok altında. */
export const AGENT_ACTIVITY_MAX_SNAPSHOT_BYTES = 64 * 1024;

/**
 * - `working`: ajan bir tur üzerinde çalışıyor.
 * - `needs-approval`: ajan bir eylem için izin bekliyor.
 * - `asked-question`: ajan kullanıcıdan yanıt/girdi bekliyor.
 * - `finished`: tur bitti (sonuç).
 * - `failed`: tur hatayla bitti.
 */
export const agentActivityStateSchema = z.enum([
  'working',
  'needs-approval',
  'asked-question',
  'finished',
  'failed',
]);
export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;

/** Bildirim üreten (uyarı) durumlar; `working` yalnızca süren iş kartını besler. */
export const AGENT_ACTIVITY_ALERT_STATES: ReadonlySet<AgentActivityState> = new Set([
  'needs-approval',
  'asked-question',
  'finished',
  'failed',
]);

export const agentActivityEntrySchema = z.object({
  conversationId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  state: agentActivityStateSchema,
  /** Sohbet başlığı (yoksa görev adı). */
  title: z.string(),
  projectName: z.string(),
  providerName: z.string(),
  /** Kısa önizleme (ajanın son mesajı ya da onay/soru metni); yoksa boş. */
  preview: z.string(),
  /** Bu sohbetin şimdiki durumuna geçtiği an (host saati, epoch ms). */
  stateChangedAt: z.number().int(),
  /** Süren işin başladığı an; yalnızca bilgi amaçlı. */
  startedAt: z.number().int().nullable(),
  /** Akış genelinde artan sürüm; istemci eski olayları bununla eler. */
  revision: z.number().int().nonnegative(),
});
export type AgentActivityEntry = z.infer<typeof agentActivityEntrySchema>;

export const agentActivitySnapshotSchema = z.object({
  /** Host kapatıldıysa (`publishing: false`) liste boştur. */
  publishing: z.boolean(),
  hostName: z.string(),
  /** Host saati (epoch ms); istemci yaş hesabını buna göre yapar (saat kayması). */
  now: z.number().int(),
  /** Snapshot'a dahil edilen son sürüm. */
  revision: z.number().int().nonnegative(),
  entries: z.array(agentActivityEntrySchema),
});
export type AgentActivitySnapshot = z.infer<typeof agentActivitySnapshotSchema>;

export const agentActivityEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('upsert'),
    now: z.number().int(),
    entry: agentActivityEntrySchema,
    /**
     * Host'un geçiş kararı: bu güncelleme yeni bir uyarı durumuna giriş mi? (Tekrarlar ve açılış
     * tohumlaması `false`.) İstemci ayrıca kendi tercihlerine ve ön plan durumuna göre süzer.
     */
    alert: z.boolean(),
  }),
  z.object({
    type: z.literal('remove'),
    now: z.number().int(),
    conversationId: z.string(),
    revision: z.number().int().nonnegative(),
  }),
  /** Yayın ayarı değişti: istemci snapshot'ı yeniden çekmeli. */
  z.object({
    type: z.literal('publishing'),
    now: z.number().int(),
    publishing: z.boolean(),
    revision: z.number().int().nonnegative(),
  }),
]);
export type AgentActivityEvent = z.infer<typeof agentActivityEventSchema>;

export const agentActivityContract = defineContract({
  getSnapshot: procedure({ input: z.void(), output: agentActivitySnapshotSchema }),
  events: eventStream({
    key: z.void().optional(),
    event: agentActivityEventSchema,
  }),
});

export type AgentActivityContract = typeof agentActivityContract;
