# Orkestra kancaları (lifecycle hooks)

Kullanıcının tanımladığı komutları Orkestra olaylarında çalıştıran, **gözlemsel** bir özellik.
Kod: `apps/orkestra-desktop/src/core/features/lifecycle-hooks/`.

## Olaylar ve bağlandıkları yerler

| Olay | Kaynak |
| --- | --- |
| `conversation.prompt-submitted` | `features/conversations/node/wire-controller.ts` — renderer'ın `acp.sendPrompt` çağrısı (yalnızca ACP sohbetleri; TUI/PTY sohbetlerinde prompt metni gözlemlenemez; Orkestra şef→işçi `sendPrompt`'u kullanıcı prompt'u değildir, bağlanmadı) |
| `conversation.turn-ended` | `AgentStatusService` `agent:event` → `stop` (`outcome: completed`) ve `error` (`outcome: error`); ACP ve TUI ortak |
| `conversation.permission-requested` | `agent:event` → `notification` + `permission_prompt` |
| `task.created` / `task.archived` | `TaskService` `task:created` / `task:archived` kancaları |

`node/hook-event-bridge.ts` ilk üç dışındaki aboneliklerin tamamını kurar (`main/bootstrap/boot/phases/services.ts`).
Üreticiler yalnızca `api/node/hook-event-bus.ts` içindeki `emitLifecycleHookEvent` çağrısını kullanır;
çağrı beklemez ve asla fırlatmaz.

## Güvenlik sözleşmesi

- **Yalnızca kullanıcı yazar.** Tanımlar yalnızca `lifecycleHooks` Wire sözleşmesinden (Ayarlar → Kancalar,
  renderer) yazılır. `.orkestra.json`, `.claude/`, eklenti paketleri, ajan araçları, MCP ve uzak erişim
  bu yüzeye bağlı değildir (`node/hook-write-surface.test.ts` bunu yapısal olarak korur). Uzak erişim izin
  listesine `lifecycleHooks` **eklenmemelidir**.
- **Mühürlü dosya.** `<userData>/lifecycle-hooks.json` sürümlü JSON'dur (`defineVersionedSchema`, v1) ve
  HMAC-SHA256 ile mühürlenir; anahtar şifreli uygulama secret deposundadır
  (`lifecycle-hooks.integrity-key`). Dosya uygulama dışında değiştirilirse (ör. dosya erişimi olan bir ajan)
  mühür tutmaz; yapılandırma yok sayılır ve kancalar kapalı kalır (`status: tampered`). Güvenli depolama
  yoksa okuma kapalı, yazma hata verir. Dosya yalnızca başlangıçta okunur.
- **Olay verisi komuta gömülmez.** Komut metni kullanıcının yazdığı haliyle çalışır. Olay verisi yalnızca
  stdin'e JSON olarak yazılır. Ortama yalnızca `ORKESTRA_HOOK_EVENT`, `ORKESTRA_TASK_ID`,
  `ORKESTRA_CONVERSATION_ID`, `ORKESTRA_PROJECT_ID` eklenir (kimlikler `^[A-Za-z0-9_.:-]{1,128}$`
  dışındaysa kanca çalışmaz). Prompt/mesaj metni env'e konmaz. Yer tutucu ikamesi yoktur.
- **Ortam ve kabuk.** Env `buildTerminalEnv` (PTY ile aynı yardımcı) üzerinden, kullanıcı kabuk env'i
  tabanıyla kurulur. Komut satırı `resolveLocalPtySpawn` ile `shellSetup && komut` olarak planlanır;
  `shellSetup` yalnızca host ayarlarından (host-settings runtime) gelir, depo yapılandırmasından değil.
  Çalışma dizini kullanıcının ev dizinidir.
- **Yalıtım.** Aynı kanca için eşzamanlı çalıştırma 1 (fazlası atlanır ve günlüğe yazılır), genel
  eşzamanlılık 4, dakikada en çok 30 başlatma. Zaman aşımı varsayılan 30 sn, üst sınır 300 sn; dolunca
  süreç grubu SIGTERM, 2 sn sonra SIGKILL alır (Windows'ta `taskkill /T /F`). Kanca hatası yalnızca günlüğe düşer.
- **Yalnızca yerel projeler.** `node/local-project.ts`: SSH/uzak ya da bilinmeyen projelerde kanca çalışmaz.
- **Günlük.** Kanca başına son 20 çalıştırma bellekte tutulur (uygulama kapanınca silinir): olay, başlangıç,
  süre, çıkış kodu, kırpılmış (2000 karakter) ve `redactAll` ile maskelenmiş stdout/stderr kuyruğu.

## Parçalar

- `api/hook-config.ts` — şema, sınırlar, doğrulama; `api/hook-runs.ts` — günlük kaydı; `api/contract.ts` — Wire.
- `node/hook-dispatcher.ts` — eşleme, sınırlar, env/stdin kurulumu, günlük (süreç çalıştırıcı enjekte edilir).
- `node/hook-process-runner.ts` — gerçek süreç çalıştırıcı. `node/hook-config-store.ts` — mühürlü dosya.
- `browser/LifecycleHooksSettingsPage.tsx` — Ayarlar → Kancalar.
